// 共享日志模块：全局单例 logger，避免各文件重复创建
import createLogger from "@xiaoqiong0v0/opencode-plugin-logger"

const log = createLogger("opencode-ssh-tool")

export default log