# kos-backup

KOS 系统应用项目：扩展包 — 备份策略、恢复、演练与目标。

- 设计：`tsic/kos-design` 仓的 `kos-backup/`（范围、契约、验收、决策记录）
- 设计依据：`tsic/kos-design@05bf60a`

## 边界

- 备份策略与恢复作业由 kosd 控制器执行；本项目只提供界面与动作。
- 恢复默认到新实例；原地恢复必须显式声明并停机。
- 不把快照宣传成备份（KOSD-F-12）；不删除源数据或绕过恢复流程；不实现存储后端或复制协议。
- 本产品无自有数据面：策略、运行与恢复由内核对象承载，窗口只读投影并提交动作。因此 `App` 清单的 `backend` 缺席，应用是 UI-only（KOSD-C-73、KOSD-C-12）。

## 制品

`kos-backup` 是独立扩展包，以系统组件安装，与第三方扩展走同一条打包与安装路径（KOSD-C-17、SDK-C-4）。

| 部分 | 位置 | 职责 |
|---|---|---|
| 扩展声明 | `declaration.go` | KOSD-C-18 声明与 `App` 窗口清单（KOSD-C-73）：窗口默认/最小尺寸、`single` 实例模式、`normal` 默认状态、独立 origin 的入口、本包图标、空权限集 |
| UI 资产 | `assets/` | 随包分发的文档、图标与浏览器侧模块；包摘要覆盖清单与全部资产 |
| 打包入口 | `cmd/kos-backup-pack` | 经 kos-sdk `packaging` 校验并生成带摘要的包，打印安装请求要写的摘要 |
| 控制面客户端 | `assets/app/control.js` | 只经控制面 API 读写（KOSD-C-12）：投影带观测时间、写请求返回已接受与对象引用、一次调用一个请求、不缓存不重试不翻页 |
| 备份页模型 | `assets/app/model.js` | BACKUP-C-1 的逐项读视图：策略、运行、目标与失败域、演练与差异项；2 分钟陈旧阈值（KOSD-C-13）；目标未配置或对象不可读时给原因 |
| 动作提交 | `assets/app/actions.js` | 恢复与演练入口的提交骨架：恢复默认提恢复到新实例（BACKUP-C-3），演练经控制面动作请求触发（KOSD-C-42） |
| 窗口渲染 | `assets/app/render.js` | BACKUP-C-1 的四项视图：策略、运行、目标与失败域、演练与差异项逐项可读；陈旧标记；未配置目标、不可读对象与演练失败给原因与差异项 |
| 窗口装配 | `assets/app/main.js`、`assets/app/window.css` | 按控制面返回的游标读完全部策略页后渲染；恢复与演练表单提交后显示已接受与对象引用，不等待终态 |

窗口文档 `assets/index.html` 是入口，加载 `assets/app/main.js`；同源控制面 API 由桌面 BFF 代理（KOSD-C-12），窗口不自建数据路径。策略、运行、目标与演练的渲染与入口界面由 `assets/app/render.js` 承载，读取与提交复用上面的模块。

## 构建与测试

```sh
make build        # 产出 dist/kos-backup-<version>.tar.gz，并打印摘要
make verify       # gofmt + go vet + 模块语法检查
make test         # Go 用例 + 浏览器侧用例
make acceptance   # 只跑 tests/acceptance，一条命令
```

## 验收用例

用例住在实现仓，以 TC 编号命名：

| 目录 | 覆盖 |
|---|---|
| `tests/acceptance/BACKUP-TC-1/` | 备份页逐项读取：三种状态各读同一页，状态等于内核对象；陈旧标记；未配置目标与对象不可读的原因；恢复与演练入口。`render.test.js` 另按渲染后的窗口文档核对四项视图、陈旧标记、原因与入口表单的默认值 |
| `tests/acceptance/BACKUP-TC-71/` | 演练失败：失败状态、原因指向文件数/字节数、差异项可读，备份不被标记为成功；演练动作经控制面提交。`render.test.js` 另核对页面上呈现的失败状态、原因与差异项 |
| `tests/acceptance/KOSD-TC-155/` | 装载与卸载：窗口随系统组件出现与消失，其余产品与内核对象不受影响；摘要不匹配被拒绝；包内条目与清单声明一一对应 |

Go 用例覆盖制品与装载；浏览器侧用例覆盖窗口的数据面，以 `node --test` 运行，控制面由用例内的假实现按控制面 API 的路由回答。
