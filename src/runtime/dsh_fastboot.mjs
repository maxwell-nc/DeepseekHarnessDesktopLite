/**
 * dsh 启动加速补丁（壳侧注入，不改 dsh 任何文件）
 * ================================================
 *
 * 问题
 * ----
 * dsh 的 `@deepseek-ai/dsh-client-modules` 会在**每注册一个插件**时，把全部前端
 * client bundle 重新拼接一遍（含逐行生成的 identity sourcemap）。实测一次启动里
 * 它被调用 7 次，合计约 3.0 秒，占 dsh 冷启动（约 5.3 秒）的一半以上；而启动阶段
 * 这些产物**没有任何消费者**——前端还没连上来。
 *
 * 做法
 * ----
 * 把 `composed` / `responses` / `batchResponses` / `previousBatchResponses` 改成
 * 访问器：启动期间 `compose()` 只记账不计算，**首次被读时才算一次**，之后立刻
 * 恢复 dsh 原本的逻辑（含 HMR 重建时的同步 compose）。
 *
 * 安全性
 * ------
 * 只做「延迟」，不改任何计算结果：
 *   * 首次读取时按当时的完整表格算一次，结果与不加速时完全一致；
 *   * 若有人在启动中途读图，只是让加速失效，不会给出错误结果；
 *   * 整个补丁包在 try/catch 里，任何异常都只是「没加速」，绝不阻断 dsh 启动；
 *   * 设 `DSH_UI_FASTBOOT=0` 可整体关闭。
 */

const MARK = "[dsh-fastboot]";
const ENABLED = (process.env.DSH_UI_FASTBOOT ?? "1") !== "0";
const TARGET = process.env.DSH_FASTBOOT_TARGET;
const VERBOSE = (process.env.DSH_UI_FASTBOOT_VERBOSE ?? "0") === "1";

const LAZY_FIELDS = ["composed", "responses", "batchResponses", "previousBatchResponses"];

function say(message) {
  if (VERBOSE) process.stderr.write(`${MARK} ${message}\n`);
}

async function install() {
  const mod = await import(TARGET);
  const proto = mod.ClientModuleRegistry?.prototype;
  if (!proto || typeof proto.compose !== "function") {
    say(`跳过：找不到 ClientModuleRegistry.compose（dsh 结构可能变了）`);
    return;
  }

  const realCompose = proto.compose;
  let skipped = 0;
  let merged = null;

  function stateOf(self) {
    let state = self.__dshFastboot;
    if (state === undefined) {
      state = self.__dshFastboot = {
        booting: true,
        dirty: false,
        busy: false,
        store: Object.create(null),
      };
      for (const field of LAZY_FIELDS) {
        state.store[field] = self[field];
        Object.defineProperty(self, field, {
          configurable: true,
          enumerable: false,
          get() {
            const live = self.__dshFastboot;
            if (live.booting && live.dirty && !live.busy) materialize(self);
            return self.__dshFastboot.store[field];
          },
          set(value) {
            self.__dshFastboot.store[field] = value;
          },
        });
      }
    }
    return state;
  }

  function materialize(self) {
    const state = self.__dshFastboot;
    if (!state.booting || state.busy) return;
    state.busy = true;
    const begin = performance.now();
    try {
      state.dirty = false;
      self.composed = realCompose.call(self);
    } finally {
      state.busy = false;
      // 一次算完就交回原逻辑：之后 HMR / 插件增删都按 dsh 原本的节奏同步组合
      state.booting = false;
    }
    merged = performance.now() - begin;
    say(`合并完成：跳过 ${skipped} 次重复组合，只算了 1 次（${merged.toFixed(0)}ms）`);
  }

  proto.compose = function fastbootCompose() {
    const state = stateOf(this);
    if (state.booting) {
      // 直接读 store，别走 this.composed —— 那会触发 getter，等于立刻物化
      const previous = state.store.composed;
      state.dirty = true;
      skipped += 1;
      return previous;
    }
    return realCompose.call(this);
  };

  say("补丁已装");
}

try {
  if (ENABLED && TARGET) await install();
} catch (error) {
  // 加速失败绝不影响 dsh 启动
  process.stderr.write(`${MARK} 安装失败，按原样继续：${error && error.message}\n`);
}
