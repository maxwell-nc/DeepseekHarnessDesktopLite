/**
 * 极简 QR 码编码器（纯 JS，零依赖）—— 只做本插件需要的那一件事：
 * 把一段 ASCII 链接编成二维码，输出 SVG 字符串。
 *
 * 为什么自己写：插件是「源码即产物」的目录，跟着 dist/plugins 走，不能指望
 * 运行时能 npm install 一个 qrcode 包；dsh 自带的依赖里也没有可复用的编码器
 * （documentpreview 里那个 "qrcode" 只是文件扩展名表里的一项）。
 *
 * 覆盖范围（够用就行，不做通用库）：
 *   - 字节模式（链接全是 ASCII；非 ASCII 走 TextEncoder，一样能编）
 *   - 纠错等级 M，装不下自动降级到 L
 *   - version 1..10（M 下最多 216 字节，L 下 274 字节，链接几十字节绰绰有余）
 *   - 8 种掩码按标准罚分自动挑
 *
 * 实现严格按 ISO/IEC 18004 的流程走：数据编码 → 分块 + Reed-Solomon →
 * 排布功能图形 → 之字形填数据 → 掩码 + 罚分 → 填格式/版本信息。
 * 生成的是标准二维码，任何扫码器都能读。
 */

/** 纠错等级在格式信息里的 2 bit 编码（L=01 / M=00 / Q=11 / H=10）。 */
const EC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 }

/**
 * 每个 version 的总码字数（数据 + 纠错）。用来校验分块表。
 * 索引 = version - 1。
 */
const TOTAL_CODEWORDS = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346]

/**
 * 分块表：BLOCKS[等级][version] = [每块纠错码字数, [[块数, 每块数据码字数], ...]]。
 *
 * 两个组是因为 v8 起同一 version 里数据块长度会差 1 字节（前一组短、后一组长）。
 * 表来自 ISO/IEC 18004 的 Table 9，只抄了 L 和 M 两档 —— 本插件用不上 Q/H。
 */
const BLOCKS = {
  L: {
    1: [7, [[1, 19]]],
    2: [10, [[1, 34]]],
    3: [15, [[1, 55]]],
    4: [20, [[1, 80]]],
    5: [26, [[1, 108]]],
    6: [18, [[2, 68]]],
    7: [20, [[2, 78]]],
    8: [24, [[2, 97]]],
    9: [30, [[2, 116]]],
    10: [18, [[2, 68], [2, 69]]]
  },
  M: {
    1: [10, [[1, 16]]],
    2: [16, [[1, 28]]],
    3: [26, [[1, 44]]],
    4: [18, [[2, 32]]],
    5: [24, [[2, 43]]],
    6: [16, [[4, 27]]],
    7: [18, [[4, 31]]],
    8: [22, [[2, 38], [2, 39]]],
    9: [22, [[3, 36], [2, 37]]],
    10: [26, [[4, 43], [1, 44]]]
  }
}

/**
 * 对齐图形中心坐标表，索引 = version - 1。
 * v1 没有对齐图形（返回空数组），所以表里留空。
 */
const ALIGN_POSITIONS = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50]
]

/** v7 起才有的版本信息（18 bit），索引 = version - 1，前 6 项留空。 */
const VERSION_INFO = [
  null,
  null,
  null,
  null,
  null,
  null,
  0x07c94, // v7  000111110010010100
  0x085bc, // v8  001000010110111100
  0x09a99, // v9  001001101010011001
  0x0a4d3 // v10 001010010011010011
]

/* -------------------------------------------------------------------------- */
/* GF(256) 与 Reed-Solomon                                                      */
/* -------------------------------------------------------------------------- */

/** 本原多项式 x^8+x^4+x^3+x^2+1（0x11D）下的指数/对数表。 */
const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)

;(() => {
  let x = 1
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x
    GF_LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255]
})()

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0
  return GF_EXP[GF_LOG[a] + GF_LOG[b]]
}

/**
 * 生成多项式 g(x) = Π (x - α^i)，i = 0..ecLength-1。
 * 返回的系数从最高次到最低次，首项恒为 1。
 */
function rsGenerator(ecLength) {
  let poly = [1]
  for (let i = 0; i < ecLength; i += 1) {
    const next = new Array(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j] // 乘 x：整体升一次
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]) // 乘 α^i
    }
    poly = next
  }
  return poly
}

/**
 * 算一段数据的纠错码字：数据当多项式，取 mod g(x) 的余数。
 * 走 LFSR 形式，边读边消，不用真的做长除法。
 */
function rsEncode(data, ecLength) {
  const generator = rsGenerator(ecLength)
  const remainder = new Uint8Array(ecLength)
  for (const byte of data) {
    const factor = byte ^ remainder[0]
    remainder.copyWithin(0, 1)
    remainder[ecLength - 1] = 0
    for (let i = 0; i < ecLength; i += 1) remainder[i] ^= gfMul(generator[i + 1], factor)
  }
  return remainder
}

/* -------------------------------------------------------------------------- */
/* 数据编码                                                                     */
/* -------------------------------------------------------------------------- */

/** 该 version + 等级下能装多少数据码字。 */
function dataCapacity(version, ecLevel) {
  const groups = BLOCKS[ecLevel][version][1]
  let total = 0
  for (const [count, perBlock] of groups) total += count * perBlock
  return total
}

/**
 * 把文本编成数据码字（byte 模式）。
 * 装不下返回 null，让调用方去试下一个 version。
 */
function encodeData(text, version, ecLevel) {
  const bytes = new TextEncoder().encode(text)
  const capacityBits = dataCapacity(version, ecLevel) * 8

  const bits = []
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1)
  }

  push(0b0100, 4) // 模式指示符：byte
  push(bytes.length, version < 10 ? 8 : 16) // 字符计数指示符
  for (const byte of bytes) push(byte, 8)

  if (bits.length > capacityBits) return null

  // 结束符：最多 4 个 0，装得下几个算几个
  const terminator = Math.min(4, capacityBits - bits.length)
  for (let i = 0; i < terminator; i += 1) bits.push(0)
  // 补到字节边界
  while (bits.length % 8 !== 0) bits.push(0)
  // 再用 0xEC / 0x11 交替填满
  const pads = [0xec, 0x11]
  for (let i = 0; bits.length < capacityBits; i += 1) push(pads[i % 2], 8)

  const codewords = new Uint8Array(bits.length / 8)
  for (let i = 0; i < codewords.length; i += 1) {
    let value = 0
    for (let j = 0; j < 8; j += 1) value = (value << 1) | bits[i * 8 + j]
    codewords[i] = value
  }
  return codewords
}

/**
 * 按分块表切块、各算各的纠错，再按标准交错成一个码字流。
 * 交错顺序是「先按列取数据码字，再按列取纠错码字」—— 短块先取完就跳过。
 */
function interleave(dataCodewords, version, ecLevel) {
  const [ecPerBlock, groups] = BLOCKS[ecLevel][version]
  const blocks = []
  let offset = 0
  for (const [count, perBlock] of groups) {
    for (let i = 0; i < count; i += 1) {
      const data = dataCodewords.subarray(offset, offset + perBlock)
      offset += perBlock
      blocks.push({ data, ec: rsEncode(data, ecPerBlock) })
    }
  }

  const maxData = Math.max(...blocks.map((block) => block.data.length))
  const out = []
  for (let i = 0; i < maxData; i += 1) {
    for (const block of blocks) if (i < block.data.length) out.push(block.data[i])
  }
  for (let i = 0; i < ecPerBlock; i += 1) {
    for (const block of blocks) out.push(block.ec[i])
  }
  return Uint8Array.from(out)
}

/* -------------------------------------------------------------------------- */
/* 矩阵排布                                                                     */
/* -------------------------------------------------------------------------- */

/** 格式信息：5 bit 数据 + 10 bit BCH，再异或固定掩码 0x5412。 */
function formatBits(ecLevel, mask) {
  const data = (EC_FORMAT_BITS[ecLevel] << 3) | mask
  let remainder = data << 10
  for (let i = 14; i >= 10; i -= 1) {
    if ((remainder >>> i) & 1) remainder ^= 0x537 << (i - 10)
  }
  return ((data << 10) | remainder) ^ 0x5412
}

/** 版本信息：6 bit 版本号 + 12 bit BCH（v7 起才用）。 */
function versionInfoBits(version) {
  let remainder = version
  for (let i = 0; i < 12; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25)
  return (version << 12) | remainder
}

/** 掩码判定函数：返回 true 表示这一格要翻转。 */
function maskAt(mask, x, y) {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0
    case 1:
      return y % 2 === 0
    case 2:
      return x % 3 === 0
    case 3:
      return (x + y) % 3 === 0
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
  }
}

/**
 * 建一个完整的二维码矩阵。
 *
 * @param text - 要编码的内容（本插件里是链接）。
 * @param ecLevel - 'M'（默认）或 'L'。
 * @returns { size, modules } —— modules[y][x] 为 true 表示黑格。
 */
export function qrMatrix(text, ecLevel = 'M') {
  const levels = ecLevel === 'L' ? ['L'] : ['M', 'L']
  let chosen = null
  for (const level of levels) {
    for (let version = 1; version <= 10; version += 1) {
      const data = encodeData(text, version, level)
      if (data === null) continue
      chosen = { level, version, data }
      break
    }
    if (chosen !== null) break
  }
  if (chosen === null) throw new Error('qr: 内容太长，version 10 也装不下')

  const { level, version } = chosen
  const size = version * 4 + 17
  const modules = Array.from({ length: size }, () => new Array(size).fill(false))
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false))

  /** 写功能图形，同时打上「这格不是数据」的标记。 */
  const setFunction = (row, col, dark) => {
    if (row < 0 || row >= size || col < 0 || col >= size) return
    modules[row][col] = dark
    isFunction[row][col] = true
  }

  // 时序图形：第 6 行 / 第 6 列整条铺满，偶数格黑
  for (let i = 0; i < size; i += 1) {
    setFunction(6, i, i % 2 === 0)
    setFunction(i, 6, i % 2 === 0)
  }

  // 三个定位图形（含分隔符）：以中心为原点画 9x9 的方块
  const drawFinder = (centerRow, centerCol) => {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy))
        // 距离 2 和 4 是白的（白环 + 分隔符），其余是黑的
        setFunction(centerRow + dy, centerCol + dx, distance !== 2 && distance !== 4)
      }
    }
  }
  drawFinder(3, 3)
  drawFinder(3, size - 4)
  drawFinder(size - 4, 3)

  // 对齐图形：5x5，中心黑、外圈黑、中间一圈白；和定位图形重叠的位置跳过
  const positions = ALIGN_POSITIONS[version - 1]
  const last = positions.length - 1
  for (let i = 0; i < positions.length; i += 1) {
    for (let j = 0; j < positions.length; j += 1) {
      const corner = (i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)
      if (corner) continue
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          setFunction(positions[i] + dy, positions[j] + dx, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
        }
      }
    }
  }

  // 格式信息（先占位成掩码 0），随后按选定掩码重画；顺带占掉固定的暗模块
  const drawFormat = (mask) => {
    const bits = formatBits(level, mask)
    const bit = (i) => ((bits >>> i) & 1) !== 0
    for (let i = 0; i <= 5; i += 1) setFunction(i, 8, bit(i))
    setFunction(7, 8, bit(6))
    setFunction(8, 8, bit(7))
    setFunction(8, 7, bit(8))
    for (let i = 9; i < 15; i += 1) setFunction(8, 14 - i, bit(i))
    for (let i = 0; i < 8; i += 1) setFunction(8, size - 1 - i, bit(i))
    for (let i = 8; i < 15; i += 1) setFunction(size - 15 + i, 8, bit(i))
    setFunction(size - 8, 8, true) // 恒黑的暗模块
  }
  drawFormat(0)

  // 版本信息（v7 起）：右上角和左下角各一份
  if (version >= 7) {
    const bits = VERSION_INFO[version - 1] ?? versionInfoBits(version)
    for (let i = 0; i < 18; i += 1) {
      const dark = ((bits >>> i) & 1) !== 0
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      setFunction(b, a, dark)
      setFunction(a, b, dark)
    }
  }

  // 之字形填数据：从右下角起，两列一组向上/向下蛇形，跳过第 6 列
  const stream = interleave(chosen.data, version, level)
  let index = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const col = right - j
        const upward = ((right + 1) & 2) === 0
        const row = upward ? size - 1 - vert : vert
        if (isFunction[row][col] || index >= stream.length * 8) continue
        modules[row][col] = ((stream[index >>> 3] >>> (7 - (index & 7))) & 1) !== 0
        index += 1
      }
    }
  }

  // 逐个掩码试：套上掩码 + 对应的格式信息，算罚分，取最小
  let best = null
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = modules.map((row) => row.slice())
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (!isFunction[y][x] && maskAt(mask, x, y)) candidate[y][x] = !candidate[y][x]
      }
    }
    // 格式信息按该掩码重画（这一步只动功能格，不影响数据）
    const bits = formatBits(level, mask)
    const bit = (i) => ((bits >>> i) & 1) !== 0
    const put = (row, col, dark) => {
      candidate[row][col] = dark
    }
    for (let i = 0; i <= 5; i += 1) put(i, 8, bit(i))
    put(7, 8, bit(6))
    put(8, 8, bit(7))
    put(8, 7, bit(8))
    for (let i = 9; i < 15; i += 1) put(8, 14 - i, bit(i))
    for (let i = 0; i < 8; i += 1) put(8, size - 1 - i, bit(i))
    for (let i = 8; i < 15; i += 1) put(size - 15 + i, 8, bit(i))
    put(size - 8, 8, true)

    const score = penalty(candidate, size)
    if (best === null || score < best.score) best = { score, modules: candidate }
  }

  return { size, modules: best.modules, version, ecLevel: level }
}

/** 标准罚分：连块、2x2 同色、类定位图形、黑白比例失衡。 */
function penalty(matrix, size) {
  let score = 0

  // 规则 1：行/列里连续同色 >= 5 个，每个 3 分，超出的每格再加 1 分
  for (let i = 0; i < size; i += 1) {
    for (const read of [
      (k) => matrix[i][k],
      (k) => matrix[k][i]
    ]) {
      let run = 1
      for (let k = 1; k < size; k += 1) {
        if (read(k) === read(k - 1)) {
          run += 1
        } else {
          if (run >= 5) score += 3 + (run - 5)
          run = 1
        }
      }
      if (run >= 5) score += 3 + (run - 5)
    }
  }

  // 规则 2：2x2 同色块，每块 3 分
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const first = matrix[y][x]
      if (first === matrix[y][x + 1] && first === matrix[y + 1][x] && first === matrix[y + 1][x + 1]) {
        score += 3
      }
    }
  }

  // 规则 3：出现类定位图形的 11 格花纹，每次 40 分
  const patterns = [
    [true, false, true, true, true, false, true, false, false, false, false],
    [false, false, false, false, true, false, true, true, true, false, true]
  ]
  const matches = (read, start) =>
    patterns.some((pattern) => pattern.every((expected, offset) => read(start + offset) === expected))
  for (let i = 0; i < size; i += 1) {
    for (let k = 0; k + 11 <= size; k += 1) {
      if (matches((j) => matrix[i][j], k)) score += 40
      if (matches((j) => matrix[j][i], k)) score += 40
    }
  }

  // 规则 4：黑格占比偏离 50% 越远扣越多
  let dark = 0
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) if (matrix[y][x]) dark += 1
  const total = size * size
  const deviation = Math.abs(dark * 20 - total * 10)
  score += (Math.ceil(deviation / total) - 1) * 10

  return score
}

/**
 * 把链接编成二维码 SVG。
 *
 * 输出的是完整 `<svg>`（自带白底），前端直接塞进 `img` 的 data URL 即可。
 * 颜色写死不走参数：这个 SVG 是要拼进 data URL 的，少一个拼接点少一份风险。
 *
 * @param text - 要编码的内容。
 * @param options.margin - 静区宽度（格数），标准要求 >= 4。
 * @param options.scale - 每格边长（px）。
 */
export function qrSvg(text, options = {}) {
  const margin = options.margin ?? 4
  const scale = options.scale ?? 6
  const { size, modules } = qrMatrix(text)
  const dimension = (size + margin * 2) * scale

  let path = ''
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!modules[y][x]) continue
      const left = (x + margin) * scale
      const top = (y + margin) * scale
      path += `M${left} ${top}h${scale}v${scale}h-${scale}z`
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dimension}" height="${dimension}"` +
    ` viewBox="0 0 ${dimension} ${dimension}" shape-rendering="crispEdges">` +
    `<rect width="${dimension}" height="${dimension}" fill="#ffffff"/>` +
    `<path d="${path}" fill="#1b2130"/>` +
    `</svg>`
  )
}

/** 暴露给自测用：拿内部码字流做已知向量比对。 */
export const internals = { encodeData, interleave, rsEncode, rsGenerator, formatBits, versionInfoBits, BLOCKS, TOTAL_CODEWORDS }
