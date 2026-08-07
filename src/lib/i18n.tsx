import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react'
import { languageFromLocale, type UiLanguage } from '../../shared/locales'

type TranslationParameters = Record<string, string | number>

const ZH_CN: Record<string, string> = {
  'SCANNING LOCAL SYSTEM': '正在扫描本机系统',
  'Starting local Console Core…': '正在启动本机 Console Core…',
  'Console Core is connected over a local Unix socket.': 'Console Core 已通过本机 Unix Socket 连接。',
  'Private local Core connected through a Unix socket. No TCP port is open.': '本机私有 Core 已通过 Unix Socket 连接，未开放任何 TCP 端口。',
  'Starting the private local Core…': '正在启动本机私有 Core…',
  'Reconnecting to the private local Core…': '正在重新连接本机私有 Core…',
  'The private local Core is offline. Agent Console will keep retrying without writing the state file directly.': '本机私有 Core 已离线。Agent Console 会继续重试，不会绕过 Core 直接写入状态文件。',
  'The private local Core disconnected. Reconnecting…': '本机私有 Core 已断开，正在重新连接…',
  'STARTING': '正在启动',
  'CONNECTED': '已连接',
  'RECONNECTING': '正在重连',
  'OFFLINE': '已离线',
  'VERSION MISMATCH': '版本不匹配',
  'Starting': '正在启动',
  'Connected': '已连接',
  'Reconnecting': '正在重连',
  'Offline': '已离线',
  'Version mismatch': '版本不匹配',
  'Running': '运行中',
  'Thinking': '思考中',
  'Waiting': '等待中',
  'Idle': '空闲',
  'Finished': '已完成',
  'Error': '错误',
  'Stopped': '已停止',
  'Terminal': '终端',
  'Backend': '后端',
  'Worker': '工作进程',
  'Process': '进程',
  'No live process matched': '未匹配到正在运行的进程',
  'All Projects': '全部项目',
  'Mission Control': '任务控制台',
  'Scan now': '立即扫描',
  'Discover': '发现进程',
  'Application updates': '应用更新',
  'Open application updates': '打开应用更新',
  'LOCAL CORE': '本机 CORE',
  'SCAN': '扫描',
  'VERSION': '版本',
  'UPDATE': '更新',
  '{{count}} active': '{{count}} 个活跃',
  '{{count}} waiting': '{{count}} 个等待',
  '{{count}} error': '{{count}} 个错误',
  '{{count}} errors': '{{count}} 个错误',
  '{{count}} Agent restored': '已恢复 {{count}} 个 Agent',
  '{{count}} Agents restored': '已恢复 {{count}} 个 Agent',
  'Local process scan complete': '本机进程扫描完成',
  'Agent updated': 'Agent 已更新',
  'Agent added to Mission Control': 'Agent 已加入任务控制台',
  'Agent removed': 'Agent 已移除',
  'Project updated': '项目已更新',
  'Project created': '项目已创建',
  'Project deleted': '项目已删除',
  'Settings saved': '设置已保存',
  'Update downloaded — restart when you are ready': '更新已下载，准备好后即可重启安装',
  'Changes were not saved. {{message}}': '更改未能保存。{{message}}',
  'AGENT CONSOLE': 'AGENT CONSOLE',
  'LOCAL MISSION CONTROL': '本机任务控制台',
  'Search projects and agents': '搜索项目和 Agent',
  'Project Explorer': '项目浏览器',
  'PROJECTS': '项目',
  'New project': '新建项目',
  'Expand project': '展开项目',
  'Collapse project': '折叠项目',
  'Open project · Double-click to edit': '打开项目 · 双击编辑',
  '{{count}} active of {{total}}': '{{total}} 个中有 {{count}} 个活跃',
  'Edit {{name}}': '编辑 {{name}}',
  'Edit agent': '编辑 Agent',
  'Add Agent': '添加 Agent',
  'LOCAL SYSTEM': '本机系统',
  '{{count}} terminals · tmux ready': '{{count}} 个终端 · tmux 已就绪',
  '{{count}} terminals · tmux unavailable': '{{count}} 个终端 · tmux 不可用',
  'Settings': '设置',
  'PROJECT DASHBOARD': '项目看板',
  'MISSION OVERVIEW': '任务总览',
  'Live status, resource use, and terminal access.': '查看实时状态、资源占用和终端入口。',
  'Every project and Agent on this machine, in one view.': '在一个界面中查看本机的全部项目和 Agent。',
  'Edit Project': '编辑项目',
  'Restore workspace': '恢复工作区',
  'Status overview': '状态总览',
  'VISIBLE AGENTS': '可见 AGENT',
  'ACTIVE NOW': '当前活跃',
  'ATTENTION': '需要关注',
  'TOTAL CPU': 'CPU 总计',
  '{{count}} project': '{{count}} 个项目',
  '{{count}} projects': '{{count}} 个项目',
  '{{count}} waiting for you': '{{count}} 个正在等你',
  'Errors need review': '有错误需要检查',
  'No active errors': '当前没有错误',
  '{{value}} memory': '内存 {{value}}',
  'SCAN DEGRADED': '扫描异常',
  'SYSTEM LIVE': '系统在线',
  'Updated {{time}}': '更新于 {{time}}',
  '{{active}} active · {{waiting}} waiting · {{total}} total': '{{active}} 个活跃 · {{waiting}} 个等待 · 共 {{total}} 个',
  'Attention': '需要关注',
  'Agent': 'Agent',
  'Restore': '恢复',
  'No matching Agents': '没有匹配的 Agent',
  'No Agents in this project': '此项目中还没有 Agent',
  'Try a different search.': '请尝试其他搜索词。',
  'Add one manually or import a discovered process.': '可以手动添加，或导入已发现的进程。',
  'Add first Agent': '添加第一个 Agent',
  'Edit Agent': '编辑 Agent',
  'MEMORY': '内存',
  'RUNNING TIME': '运行时间',
  'Not configured': '未配置',
  'TERMINAL OPEN': '终端已打开',
  'NO WINDOW': '没有窗口',
  'UPDATED {{time}}': '更新于 {{time}}',
  'Focus': '聚焦',
  'Open': '打开',
  'Close the window. A tmux session keeps running.': '关闭终端窗口；tmux 会话仍会继续运行。',
  'Close window': '关闭窗口',
  'Process Discovery': '进程发现',
  'Live processes not yet assigned to a Project': '尚未分配到项目的实时进程',
  'Close': '关闭',
  'UNASSIGNED': '未分配',
  'SERVICES': '服务',
  'Filter discovered processes': '筛选已发现的进程',
  'MEM': '内存',
  'UP': '时长',
  'Add to Project': '添加到项目',
  'No unassigned processes': '没有未分配的进程',
  'Nothing matches this filter.': '没有进程符合当前筛选条件。',
  'Every detected process is already managed.': '所有已发现进程都已纳入管理。',
  'Close dialog': '关闭对话框',
  'Keep it': '保留',
  'Deleting…': '正在删除…',
  'Define how this process is identified and how its terminal should open.': '设置如何识别此进程，以及如何打开它的终端。',
  'Identity': '基本信息',
  'How this Agent appears in Mission Control': '此 Agent 在任务控制台中的显示方式',
  'Name': '名称',
  'Project': '项目',
  'Symbol': '图标',
  'Type': '类型',
  'Color label': '标记颜色',
  'Use {{color}}': '使用颜色 {{color}}',
  'Terminal & launch': '终端与启动',
  'tmux is recommended because work survives a closed window': '建议使用 tmux，这样关闭窗口后任务仍会继续',
  'Working directory': '工作目录',
  'The folder this Agent works inside.': '此 Agent 工作所在的文件夹。',
  'tmux session': 'tmux 会话',
  'Leave empty if this process does not use tmux.': '如果此进程不使用 tmux，请留空。',
  'Terminal app': '终端应用',
  'Terminal title': '终端标题',
  'Launch command': '启动命令',
  'Used only when Agent Console needs to start a new session. Leave empty for an already-running imported process.': '仅在 Agent Console 需要新建会话时使用。导入已经运行的进程时请留空。',
  'Process matching': '进程匹配',
  'How the live process is connected to this card': '如何把正在运行的进程与此卡片关联',
  'Status override': '手动状态',
  'Automatic': '自动',
  'Command match pattern': '命令匹配规则',
  'Optional, for example: codex.*product-roadmap': '可选，例如：codex.*product-roadmap',
  'Advanced: a text pattern used if the PID changes after restart.': '高级选项：重启后 PID 变化时，用此文本规则重新匹配。',
  'Log file': '日志文件',
  'Optional path to a log file': '可选的日志文件路径',
  'The last line becomes the Agent card’s latest output.': '最后一行会显示为 Agent 卡片的最新输出。',
  'Include in workspace restore': '包含在工作区恢复中',
  'Start or open this Agent when the Project is restored.': '恢复项目时启动或打开此 Agent。',
  'Delete {{name}}?': '删除 {{name}}？',
  'It will disappear from Agent Console, but its running process will not be stopped.': '它会从 Agent Console 中消失，但正在运行的进程不会停止。',
  'Delete Agent': '删除 Agent',
  'Cancel': '取消',
  'Save Agent': '保存 Agent',
  'New Project': '新建项目',
  'New Agent': '新建 Agent',
  'A Project groups related Agents, terminals, backends, and workers.': '项目用于归纳相关的 Agent、终端、后端和工作进程。',
  'Project name': '项目名称',
  'Color': '颜色',
  '{{count}} Agents': '{{count}} 个 Agent',
  'Move or delete this Project’s {{count}} Agents before deleting the Project.': '请先移动或删除此项目中的 {{count}} 个 Agent，再删除项目。',
  'This removes the empty Project from Agent Console.': '这会从 Agent Console 中移除这个空项目。',
  'Delete Project': '删除项目',
  'Save Project': '保存项目',
  'Console Settings': 'Console 设置',
  'Make Mission Control comfortable on your screen.': '调整任务控制台，让它更适合你的屏幕与使用习惯。',
  'Settings pages': '设置页面',
  'General': '常规',
  'Mobile Remote': '手机遥控',
  'Interface language': '界面语言',
  'Choose the language used by Agent Console. Changes preview instantly.': '选择 Agent Console 的界面语言，修改后立即预览。',
  'Language': '语言',
  'Simplified Chinese': '简体中文',
  'English': 'English',
  'Local Console Core': '本机 Console Core',
  'The protected background service that owns local state and Agent monitoring.': '负责本机状态与 Agent 监控的受保护后台服务。',
  'Transport': '传输方式',
  'Unix socket': 'Unix Socket',
  'Network': '网络',
  'TCP active': 'TCP 已启用',
  'No TCP listener': '未监听 TCP',
  'Core version': 'Core 版本',
  'Protocol': '协议',
  'Local-only mode: the socket is restricted to your Linux user and the Core does not listen on a network port.': '仅限本机模式：Socket 只允许你的 Linux 用户访问，Core 不监听任何网络端口。',
  'Check, download, verify, and install new Agent Console versions here.': '在这里检查、下载、校验并安装 Agent Console 新版本。',
  'Updates are off in preview mode': '预览模式下不提供更新',
  'Ready to check': '可以检查更新',
  'Checking for updates': '正在检查更新',
  'Version {{version}} is available': '新版本 {{version}} 可用',
  'Downloading version {{version}}': '正在下载版本 {{version}}',
  'Ready to restart and update': '可以重启并安装更新',
  'Agent Console is up to date': 'Agent Console 已是最新版本',
  'Update check needs attention': '更新检查需要处理',
  'Installed': '已安装',
  'Package': '安装包',
  'Available': '可用版本',
  'Last checked': '上次检查',
  'Not yet': '尚未检查',
  'Download progress {{percent}}%': '下载进度 {{percent}}%',
  'What’s new in v{{version}}': 'v{{version}} 更新内容',
  'Downloads are integrity-checked before installation.': '下载内容会在安装前进行完整性校验。',
  'Releases': '发布页面',
  'Check now': '立即检查',
  'Checking…': '正在检查…',
  'Download update': '下载更新',
  'Downloading…': '正在下载…',
  'Restart and update': '重启并更新',
  'Interface size': '界面大小',
  'Scales all text, controls, cards, and spacing together. Changes preview instantly.': '同时缩放全部文字、控件、卡片和间距，修改后立即预览。',
  'Default': '恢复默认',
  'Interface font size': '界面字号',
  'Interface font size in pixels': '以像素为单位的界面字号',
  'Font size presets': '预设字号',
  'Color world': '配色世界',
  'Choose a complete visual system, from calm paper themes to luminous night control rooms.': '从安静的纸张质感到明亮的夜间控制室，选择一套完整视觉系统。',
  'System preferences': '系统偏好',
  'Terminal behavior and local monitoring frequency.': '设置终端行为与本机监控频率。',
  'Default terminal': '默认终端',
  'Automatic — use first available': '自动——使用第一个可用终端',
  'Live scan interval': '实时扫描间隔',
  'Every second': '每 1 秒',
  'Every 2.5 seconds': '每 2.5 秒',
  'Every 5 seconds': '每 5 秒',
  'Every 10 seconds': '每 10 秒',
  'Compact Agent cards': '紧凑型 Agent 卡片',
  'Fit more Agents on screen.': '在屏幕中显示更多 Agent。',
  'Save Settings': '保存设置',
  'Mobile Remote is locked': '手机遥控已锁定',
  'Remote access will not use plaintext credential storage.': '远程访问不会使用明文凭据存储。',
  'Secure Linux storage is unavailable': 'Linux 安全存储不可用',
  'Unlock your desktop keyring, then restart Agent Console. Existing local Projects and Agents are unaffected.': '请解锁桌面密钥环，然后重启 Agent Console。现有本机项目与 Agent 不受影响。',
  'Mobile Remote needs administrator setup': '手机遥控需要管理员配置',
  'Registration stays disabled until public service settings have been installed.': '在公共服务配置安装完成前，注册功能保持禁用。',
  'Remote service is not configured': '远程服务尚未配置',
  'Install a private remote.env file with mode 0600, then run Agent Console Remote Doctor. Do not paste a Supabase secret or VPS private key into this screen.': '请安装权限为 0600 的私有 remote.env 文件，然后运行 Agent Console Remote Doctor。不要把 Supabase 密钥或 VPS 私钥粘贴到此界面。',
  'Choose a new password': '设置新密码',
  'Remote access remains locked until recovery finishes in secure storage.': '在安全存储完成恢复前，远程访问会保持锁定。',
  'New password': '新密码',
  'Confirm new password': '确认新密码',
  'Use at least 8 characters. Remote services stay disabled during recovery.': '请至少使用 8 个字符。恢复期间远程服务保持禁用。',
  'Passwords do not match.': '两次输入的密码不一致。',
  'Save new password': '保存新密码',
  'Sign in first. Login alone never grants a phone access to this computer.': '请先登录。仅登录账号不会让手机获得此电脑的访问权。',
  'Remote account action': '远程账号操作',
  'Sign in': '登录',
  'Create account': '创建账号',
  'Email (login account)': '邮箱（登录账号）',
  'Display name': '显示名称',
  'Password': '密码',
  'Use at least 8 characters. Agent Console never returns this password to the renderer after submission.': '请至少使用 8 个字符。提交后，Agent Console 不会把密码返回给界面。',
  'Forgot password?': '忘记密码？',
  'A limited Agent remote control channel — never a general terminal.': '受限的 Agent 遥控通道，绝不是通用终端。',
  'The signed public Remote path passed its health check': '已签名的公网遥控链路通过健康检查',
  'Mobile Remote is enabled but needs attention': '手机遥控已启用，但需要处理问题',
  'Mobile Remote is off': '手机遥控已关闭',
  'Turn off remote': '关闭遥控',
  'Turn on remote': '开启遥控',
  'Computer': '电脑',
  'Not registered': '未注册',
  'Public entry': '公网入口',
  'Local Gateway': '本机 Gateway',
  'Not listening': '未监听',
  'Last reachable': '最近连通',
  'Never': '从未',
  'Unknown': '未知',
  'Verify your email': '验证邮箱',
  'No Gateway or pairing code is available until this account is verified.': '账号验证完成前，Gateway 和配对码均不可用。',
  'We sent a verification message to {{email}}.': '验证邮件已发送至 {{email}}。',
  'Send again': '重新发送',
  'Connection check': '连接检查',
  'Core stays Unix-only; only Gateway may listen, and only on 127.0.0.1.': 'Core 始终只使用 Unix Socket；只有 Gateway 可以监听，而且仅限 127.0.0.1。',
  'Run Doctor': '运行 Doctor',
  'Not checked': '尚未检查',
  'Paired phones': '已配对手机',
  'Each phone has its own public key and can be revoked without changing your password.': '每台手机都有独立公钥，可以单独撤销，无需修改密码。',
  'Add phone': '添加手机',
  'No phone is paired': '尚未配对手机',
  'Turn on Mobile Remote, then create a five-minute one-time QR code.': '开启手机遥控，然后创建一个有效期五分钟的一次性二维码。',
  'Paired {{paired}} · Last seen {{lastSeen}}': '配对于 {{paired}} · 最近出现于 {{lastSeen}}',
  'Local access is already blocked; cloud sync still needs retrying.': '本机访问已被阻止；云端同步仍需重试。',
  'Retry': '重试',
  'Revoke': '撤销',
  'Keep': '保留',
  'Revoke now': '立即撤销',
  'Agent permissions': 'Agent 权限',
  'New Agents are hidden from phones. Events are redacted summaries, never terminal output.': '新 Agent 默认不会显示在手机上。事件只提供脱敏摘要，绝不包含终端原文。',
  'No Agent permissions yet': '尚无 Agent 权限',
  'Add an Agent to a Project before allowing phone access.': '请先把 Agent 添加到项目，再允许手机访问。',
  'Status': '状态',
  'Events': '事件',
  'Message': '消息',
  'Approve': '批准',
  'Interrupt': '中断',
  'sync pending': '等待同步',
  'Only one explicit, structured approval at a time': '每次只允许一次明确的结构化批准',
  'Account and this computer': '账号与此电脑',
  'Signing out does not silently delete keys or leave a half-removed workstation.': '退出登录不会悄悄删除密钥，也不会留下只移除一半的工作站。',
  'Signed in as': '当前登录',
  'Sign out': '退出登录',
  'Computer name': '电脑名称',
  'Save name': '保存名称',
  'This computer has a cloud sync change waiting to retry.': '此电脑有一项云端同步变更等待重试。',
  'Remove this workstation': '移除此工作站',
  'This first turns remote access off and revokes phones. The local encrypted key is deleted only after cloud removal succeeds.': '此操作会先关闭远程访问并撤销手机。只有云端移除成功后，才会删除本机加密密钥。',
  'Type {{name}} to confirm': '输入 {{name}} 以确认',
  'Remove workstation': '移除工作站',
  'Loading Mobile Remote settings…': '正在加载手机遥控设置…',
  'Scan with Agent Console Remote': '使用 Agent Console Remote 扫描',
  'Confirm this phone on the computer': '在电脑上确认此手机',
  'This code works once and expires in about {{count}} minute.': '此代码仅可使用一次，大约 {{count}} 分钟后失效。',
  'This code works once and expires in about {{count}} minutes.': '此代码仅可使用一次，大约 {{count}} 分钟后失效。',
  'Safety code {{code}}': '安全码 {{code}}',
  'Phone requesting access: {{name}}. Make sure the same six digits appear on the phone.': '请求访问的手机：{{name}}。请确认手机上显示相同的六位数字。',
  'Reject': '拒绝',
  'Confirm phone': '确认手机',
  'Cancel pairing': '取消配对',
  'One-time Agent Console Remote pairing QR code': 'Agent Console Remote 一次性配对二维码',
  'signed out': '已退出登录',
  'verification required': '需要验证',
  'password recovery': '密码恢复',
  'secure storage unavailable': '安全存储不可用',
  'unconfigured': '未配置',
  'disabled': '已关闭',
  'starting': '正在启动',
  'ready': '可用',
  'degraded': '服务异常',
  'Secure storage': '安全存储',
  'Protected storage is available.': '受保护存储可用。',
  'Console Core': 'Console Core',
  'Private Unix socket connected.': '私有 Unix Socket 已连接。',
  'Unix socket connected.': 'Unix Socket 已连接。',
  'Remote control is off.': '远程控制已关闭。',
  'Remote is off.': '远程控制已关闭。',
  'VPS tunnel': 'VPS 隧道',
  'HTTPS 443': 'HTTPS 443',
  'Sign in to prepare secure mobile access to this workstation.': '登录以准备对此工作站的安全手机访问。',
  'Sign in to enable remote control.': '登录以启用远程控制。',
  'Authentication has not started.': '认证尚未开始。',
  'The operating-system keyring is unavailable.': '操作系统密钥环不可用。',
  'Authentication will retry when the network is available.': '网络恢复后将重试认证。',
  'Finish password recovery before enabling remote control.': '请先完成密码恢复，再启用远程控制。',
  'Check your email to confirm the new account.': '请查收邮件以确认新账号。',
  'Choose a new password before remote control can resume.': '请先设置新密码，远程控制才能恢复。',
  'Signed in securely.': '已安全登录。',
  'Confirm your email before enabling remote control.': '请先验证邮箱，再启用远程控制。',
  'Check your email, then return here after verification.': '请查收邮件，验证后返回此处。',
  'Signed in. Mobile Remote is off until you enable it.': '登录成功。手机遥控会保持关闭，直到你手动启用。',
  'Signed out. Existing workstation pairing remains locally protected.': '已退出登录。现有工作站配对仍受本机保护。',
  'Recovery email requested. Mobile Remote remains locked.': '密码恢复邮件已发送。手机遥控仍保持锁定。',
  'Password updated. Mobile Remote remains off.': '密码已更新。手机遥控仍保持关闭。',
  'Mobile Remote is online through HTTPS 443.': '手机遥控已通过 HTTPS 443 上线。',
  'Remote authorization, the local Gateway, the tunnel, and the public HTTPS health check are ready.': '远程授权、本机 Gateway、隧道与公网 HTTPS 健康检查均已就绪。',
  'Mobile Remote is off.': '手机遥控已关闭。',
  'Local Gateway service is not active.': '本机 Gateway 服务未运行。',
  'HTTPS tunnel service is not active.': 'HTTPS 隧道服务未运行。',
  'Local Gateway service is disabled.': '本机 Gateway 服务已禁用。',
  'HTTPS tunnel service is disabled.': 'HTTPS 隧道服务已禁用。',
  'The public HTTPS endpoint reached this Gateway and its private Core health bridge.': '公网 HTTPS 端点已连通此 Gateway 及其私有 Core 健康检查桥接。',
  'The public HTTPS health check did not reach a healthy Gateway and Core.': '公网 HTTPS 健康检查未能连通健康的 Gateway 与 Core。',
  'Public reachability must be verified outside the credential-holding Core.': '必须在持有凭据的 Core 外部验证公网可达性。',
  'Terminal focused (preview)': '终端已聚焦（预览）',
  'Terminal closed (preview)': '终端窗口已关闭（预览）',
  'Workspace restored (preview)': '工作区已恢复（预览）',
  'Updates are disabled in preview mode.': '预览模式下禁用更新。',
  'Update checks are available in packaged AppImage and deb builds.': '正式 AppImage 与 deb 安装包支持更新检查。',
  'Agent Console can check the stable release channel for updates.': 'Agent Console 可以从稳定发布通道检查更新。',
  'The update is ready. Restart Agent Console to finish installing it.': '更新已准备好。请重启 Agent Console 完成安装。',
  'Checking the stable release channel…': '正在检查稳定发布通道…',
  'Download the update before installing it.': '请先下载更新，再进行安装。',
  'Agent Console will restart and finish the update.': 'Agent Console 将重启并完成更新。',
  'Agent Console is already restarting to install the update.': 'Agent Console 已在重启以安装更新。',
  'The updater is not available for this package. Your current version is unchanged.': '此安装包无法使用更新程序。当前版本不会改变。',
  'The update channel is private or unavailable. Your current version is unchanged.': '更新通道为私有或暂不可用。当前版本不会改变。',
  'No published update channel was found yet. Your current version is unchanged.': '尚未找到已发布的更新通道。当前版本不会改变。',
  'Could not reach the update server. Check your connection and try again.': '无法连接更新服务器。请检查网络后重试。',
  'The update could not be completed. Your current version is safe and unchanged.': '更新未能完成。当前版本安全且未发生改变。',
  'No supported terminal was found. Install GNOME Terminal, Kitty, or Ghostty.': '未找到受支持的终端。请安装 GNOME Terminal、Kitty 或 Ghostty。',
  'Install wmctrl to let Agent Console close external terminal windows.': '请安装 wmctrl，以便 Agent Console 关闭外部终端窗口。',
  'This Agent uses tmux, but tmux is not installed.': '此 Agent 使用 tmux，但系统尚未安装 tmux。',
  'tmux session names may only use letters, numbers, dot, dash, and underscore.': 'tmux 会话名称只能使用字母、数字、点、短横线和下划线。',
  'No launch command or tmux session is configured in this project.': '此项目中没有配置启动命令或 tmux 会话。',
  'Install a private remote.env file and restart the Console Core before using Mobile Remote.': '请安装私有 remote.env 文件并重启 Console Core，然后再使用手机遥控。',
  'Mobile Remote is configured but disarmed. Deployment checks must pass before enabling it.': '手机遥控已配置但尚未武装。部署检查通过后才能启用。',
  'Remote authorization is enabled; run Doctor to verify the external Gateway and HTTPS tunnel.': '远程授权已启用；请运行 Doctor 检查外部 Gateway 与 HTTPS 隧道。',
  'Mobile Remote has not initialized.': '手机遥控尚未初始化。',
  'Remote configuration is invalid; Mobile Remote remains disabled.': '远程配置无效；手机遥控保持关闭。',
  'Remote authentication could not initialize safely.': '远程认证无法安全初始化。',
  'Remote components could not initialize safely.': '远程组件无法安全初始化。',
  'Remote operation could not be completed safely.': '远程操作无法安全完成。',
  'Email address is invalid.': '邮箱地址无效。',
  'Password is invalid.': '密码无效。',
  'nickname is invalid.': '显示名称无效。',
  'No signup email is awaiting verification.': '当前没有等待验证的注册邮箱。',
  'Mobile Remote is not armed in the private runtime configuration.': '手机遥控尚未在私有运行时配置中武装。',
  'Enable Mobile Remote before pairing a device.': '配对设备前请先启用手机遥控。',
  'Agent not found.': '未找到 Agent。',
  'Pair and synchronize at least one active device first.': '请先配对并同步至少一台活跃设备。',
  'The pairing has not been claimed with a confirmation code.': '该配对尚未使用确认码完成认领。',
  'Remote settings phase is invalid.': '手机遥控设置阶段无效。',
  'Gateway PID is invalid.': 'Gateway PID 无效。',
  'Remote device platform is invalid.': '远程设备平台无效。',
  'Remote device state is invalid.': '远程设备状态无效。',
  'Pairing stage is invalid.': '配对阶段无效。',
  'Pairing QR image is invalid.': '配对二维码图像无效。',
  'Remote check ID is invalid.': '远程检查 ID 无效。',
  'Remote check state is invalid.': '远程检查状态无效。',
  'Authentication state could not be secured. Remote control remains locked.': '认证状态无法安全保存。远程控制保持锁定。',
  'Password recovery is in progress. Remote control is locked.': '正在恢复密码。远程控制已锁定。',
  'Remote services are unavailable on this installation; enablement was rolled back.': '此安装环境无法使用远程服务；启用操作已回滚。',
  'Remote services could not start; Core enablement was rolled back safely.': '远程服务无法启动；Core 启用状态已安全回滚。',
  'Remote services did not become active.': '远程服务未能进入运行状态。',
  'Remote authorization could not be confirmed off; a precautionary local service stop was attempted.': '无法确认远程授权已经关闭；系统已尝试预防性停止本机服务。',
  'Remote authorization is off, but one or more local Remote services could not be confirmed stopped.': '远程授权已关闭，但无法确认一个或多个本机远程服务已经停止。',
  'Remote authorization is off, but stopping the local Remote services failed.': '远程授权已关闭，但停止本机远程服务失败。',
  'Mobile Remote is not ready.': '手机遥控尚未就绪。',
  'No authentication callback is expected in the current local state.': '当前本机状态不应接收认证回调。',
  'The Core connection closed before the request completed.': 'Core 连接在请求完成前已关闭。',
  'Connect to Core before sending a request.': '请先连接 Core，再发送请求。',
  'Agent Console is closing; no new changes were accepted.': 'Agent Console 正在关闭，未接受新的更改。',
  'Agent Console is restarting to install the update; no new changes were accepted.': 'Agent Console 正在重启并安装更新，未接受新的更改。',
  'Console Core reconnected before this change could be saved. The desktop must resynchronize first.': '此更改保存前 Console Core 已重新连接；桌面端必须先重新同步。',
  'Invalid Console Core state revision.': 'Console Core 状态版本无效。',
  'Console Core reconnected before the desktop finished resynchronizing.': '桌面端完成重新同步前 Console Core 已重新连接。',
  'Console Core changed again before the desktop finished resynchronizing.': '桌面端完成重新同步前 Console Core 状态再次发生变化。',
  'The saved configuration changed in another client.': '已保存的配置已在另一个客户端中更改。',
  'The local Core version is incompatible with this desktop version.': '本机 Core 版本与当前桌面端版本不兼容。',
  'Nickname is invalid.': '显示名称无效。',
  'Workstation name is invalid.': '工作站名称无效。',
  'Invalid Agent ID': 'Agent ID 无效',
  'The operating-system keyring is unavailable; no session is stored.': '操作系统密钥环不可用；未保存任何会话。',
  'The Core initialized encrypted session storage without a plaintext fallback.': 'Core 已初始化加密会话存储，且不会回退到明文。',
  'The Core is running on its local Unix socket.': 'Core 正通过本机 Unix Socket 运行。',
  'Authorization is enabled; the desktop host must verify the separate localhost Gateway process.': '授权已启用；桌面端必须检查独立的 localhost Gateway 进程。',
  'Enable and arm Mobile Remote before checking the Gateway.': '请先启用并武装手机遥控，再检查 Gateway。',
  'Tunnel process health is owned by the desktop deployment service.': '隧道进程健康状态由桌面部署服务负责检查。',
  'Not checked yet.': '尚未检查。',
  'HTTPS tunnel': 'HTTPS 隧道',
  'Public HTTPS': '公网 HTTPS',
  'Unknown project': '未知项目',
  'Linux deb': 'Linux deb 安装包',
  'Linux rpm': 'Linux rpm 安装包',
  'Linux package': 'Linux 安装包',
  'Development preview': '开发预览版',
  'Desktop package': '桌面安装包',
  'Not set': '未设置',
  'Royal Archive': '皇家档案',
  'Navy · Ivory · Gold': '海军蓝 · 象牙白 · 金色',
  'Crisp white workspace with a naval command spine and restrained gold detail.': '明亮白色工作区，以海军蓝构成控制骨架，并以克制金色点缀。',
  'Song Porcelain': '宋瓷',
  'China · Blue & White': '中国 · 青花',
  'Porcelain white, deep cobalt, pale celadon, and one measured cinnabar accent.': '瓷白、深钴蓝、淡青瓷色，再加一笔克制的朱砂红。',
  'Kyoto Washi': '京都和纸',
  'Japan · Paper & Indigo': '日本 · 和纸与靛蓝',
  'Warm handmade paper, quiet indigo, persimmon red, and ink-soft neutrals.': '温暖手工纸、安静靛蓝、柿子红与柔和墨色中性色。',
  'Bauhaus Studio': '包豪斯工作室',
  'Germany · Primary Geometry': '德国 · 原色几何',
  'Ivory and black structure energized by primary red, blue, and yellow.': '以象牙白与黑色搭建结构，用红、蓝、黄三原色注入活力。',
  'Swiss Modern': '瑞士现代',
  'Switzerland · Editorial': '瑞士 · 编辑设计',
  'Brilliant white, disciplined charcoal, and a decisive editorial red.': '耀眼白色、严谨炭黑与果断的编辑红。',
  'Art Deco Salon': '装饰艺术沙龙',
  'Paris · Emerald & Brass': '巴黎 · 祖母绿与黄铜',
  'Blackened emerald panels, champagne brass, and a theatrical evening glow.': '深祖母绿面板、香槟黄铜与富有舞台感的夜间光泽。',
  'Nordic Fjord': '北欧峡湾',
  'Scandinavia · Mist & Pine': '斯堪的纳维亚 · 雾与松林',
  'Cool morning mist, pine-blue navigation, glacier blue, and pale timber.': '清冷晨雾、松林蓝导航、冰川蓝与浅木色。',
  'Mediterranean': '地中海',
  'Aegean · Sun & Cobalt': '爱琴海 · 阳光与钴蓝',
  'Sunlit plaster, Aegean cobalt, terracotta, and warm coastal sand.': '阳光下的灰泥、爱琴海钴蓝、赤陶与温暖海岸沙色。',
  'Sahara Atelier': '撒哈拉工坊',
  'North Africa · Sand & Clay': '北非 · 沙与陶土',
  'Layered sand, date-palm brown, fired clay, and desert brass.': '层叠沙色、椰枣棕、烧制陶土与沙漠黄铜。',
  'Sakura Editorial': '樱花编辑室',
  'Tokyo · Plum & Blossom': '东京 · 梅色与樱花',
  'Nearly-white blossom pink, deep plum, rose, and a soft tea-paper neutral.': '近白樱粉、深梅色、玫瑰色与柔和茶纸中性色。',
  'Persian Night': '波斯夜色',
  'Isfahan · Turquoise & Saffron': '伊斯法罕 · 绿松石与藏红花',
  'Midnight tile blue, luminous turquoise, saffron gold, and moonlit text.': '午夜瓷砖蓝、明亮绿松石、藏红花金与月光文字。',
  'Solarpunk Garden': '太阳朋克花园',
  'Future Earth · Leaf & Sun': '未来地球 · 叶与阳光',
  'Airy plant whites, living green, clear water blue, and solar yellow.': '通透植物白、鲜活绿色、清澈水蓝与太阳黄。',
  'Cyber Tokyo': '赛博东京',
  'Neo Tokyo · Cyan & Magenta': '新东京 · 青色与品红',
  'Inky violet control surfaces cut with electric cyan and neon magenta.': '墨紫控制界面，被电光青与霓虹品红切开。',
  'Arctic Research': '极地研究站',
  'Polar · Ice & Slate': '极地 · 冰与板岩',
  'Snow white, translucent ice blue, research-station slate, and clear cyan.': '雪白、半透明冰蓝、研究站板岩色与清澈青色。',
  'Carnival Modern': '现代嘉年华',
  'Latin America · Teal & Fuchsia': '拉丁美洲 · 蓝绿与紫红',
  'Warm festival paper with saturated teal, fuchsia, and marigold energy.': '温暖节庆纸张，配以饱和蓝绿、紫红与万寿菊色。',
  'Forest Studio': '森林工作室',
  'Craft · Moss & Walnut': '手作 · 苔藓与胡桃木',
  'Natural paper, moss green, walnut brown, and a calm botanical workspace.': '自然纸色、苔藓绿、胡桃木棕与安静的植物工作区。',
}

function interpolate(template: string, parameters: TranslationParameters = {}): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(parameters[key] ?? `{{${key}}}`))
}

export interface I18n {
  language: UiLanguage
  t: (source: string, parameters?: TranslationParameters) => string
  message: (source: string) => string
  formatTime: (value: string | number | Date) => string
  formatDateTime: (value: string | number | Date) => string
  formatDuration: (seconds: number) => string
  formatPercent: (value: number) => string
  formatBytes: (value: number) => string
}

export function detectBrowserLanguage(): UiLanguage {
  if (typeof navigator === 'undefined') return 'en'
  return languageFromLocale(navigator.languages?.[0] || navigator.language)
}

export function hasChineseTranslation(source: string): boolean {
  return Object.hasOwn(ZH_CN, source)
}

function createTranslator(language: UiLanguage) {
  return (source: string, parameters: TranslationParameters = {}): string => {
    const template = language === 'zh-CN' ? ZH_CN[source] ?? source : source
    return interpolate(template, parameters)
  }
}

function localizedMessage(source: string, language: UiLanguage, t: I18n['t']): string {
  if (language === 'en' || !source) return source
  if (hasChineseTranslation(source)) return t(source)

  let match = source.match(/^Agent Console v([^ ]+) is available\.?$/)
  if (match) return `Agent Console v${match[1]} 可用。`
  match = source.match(/^Downloading Agent Console v([^…]+)…$/)
  if (match) return `正在下载 Agent Console v${match[1]}…`
  match = source.match(/^Downloading v([^ ]+) — ([0-9.]+)%$/)
  if (match) return `正在下载 v${match[1]} — ${match[2]}%`
  match = source.match(/^You already have the latest version, v([0-9A-Za-z][0-9A-Za-z.+-]*)\.$/)
  if (match) return `当前已是最新版本 v${match[1]}。`
  match = source.match(/^Desktop v([^ ]+) and Core v([^ ]+) do not match\. Restarting Core safely…$/)
  if (match) return `桌面端 v${match[1]} 与 Core v${match[2]} 不匹配，正在安全重启 Core…`
  match = source.match(/^Core request (.+) timed out after ([0-9]+) ms\.$/)
  if (match) return `Core 请求 ${match[1]} 在 ${match[2]} 毫秒后超时。`
  match = source.match(/^(.+) terminal focused$/)
  if (match) return `${match[1]} 的终端已聚焦`
  match = source.match(/^(.+) opened in (.+)$/)
  if (match) return `${match[1]} 已在 ${match[2]} 中打开`
  match = source.match(/^(.+) terminal closed; its tmux session keeps running$/)
  if (match) return `${match[1]} 的终端窗口已关闭；tmux 会话仍在运行`
  match = source.match(/^(.+) terminal window was not found$/)
  if (match) return `未找到 ${match[1]} 的终端窗口`
  match = source.match(/^(.+) terminal is already open, but automatic focus is unavailable$/)
  if (match) return `${match[1]} 的终端已打开，但暂时无法自动聚焦`
  match = source.match(/^The (.+) process is running, but Agent Console could not identify its exact terminal window\.$/)
  if (match) return `${match[1]} 进程正在运行，但 Agent Console 无法准确识别它的终端窗口。`
  match = source.match(/^(.+) does not use tmux$/)
  if (match) return `${match[1]} 不使用 tmux`
  match = source.match(/^(.+) is already running$/)
  if (match) return `${match[1]} 已在运行`
  match = source.match(/^(.+) started$/)
  if (match) return `${match[1]} 已启动`
  match = source.match(/^(.+) is ready for the desktop terminal\.$/)
  if (match) return `${match[1]} 已可以在桌面终端中打开。`
  match = source.match(/^(.+) service is active\.$/)
  if (match) return `${t(match[1])} 服务正在运行。`
  match = source.match(/^(.+) service is in the failed state\.$/)
  if (match) return `${t(match[1])} 服务处于失败状态。`
  match = source.match(/^The main state file was unreadable, so Agent Console restored the last valid backup\.$/)
  if (match) return '主状态文件无法读取，Agent Console 已恢复最近一份有效备份。'
  match = source.match(/^Saved data could not be read\. It was preserved as (.+)\.$/)
  if (match) return `已保存数据无法读取，原文件已保留为 ${match[1]}。`
  return source
}

export function createI18n(language: UiLanguage): I18n {
  const locale = language === 'zh-CN' ? 'zh-CN' : 'en-US'
  const t = createTranslator(language)
  return {
    language,
    t,
    message: (source) => localizedMessage(source, language, t),
    formatTime: (value) => {
      const date = new Date(value)
      return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    },
    formatDateTime: (value) => {
      const date = new Date(value)
      return Number.isNaN(date.getTime()) ? t('Unknown') : date.toLocaleString(locale)
    },
    formatDuration: (seconds) => {
      if (!seconds || seconds < 0) return '—'
      if (seconds < 60) {
        const displayedSeconds = Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1).replace(/\.0$/, '')
        return language === 'zh-CN' ? `${displayedSeconds}秒` : `${displayedSeconds}s`
      }
      const minutes = Math.floor(seconds / 60)
      if (minutes < 60) return language === 'zh-CN'
        ? `${minutes}分钟 ${Math.floor(seconds % 60)}秒`
        : `${minutes}m ${Math.floor(seconds % 60)}s`
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return language === 'zh-CN' ? `${hours}小时 ${minutes % 60}分钟` : `${hours}h ${minutes % 60}m`
      const days = Math.floor(hours / 24)
      return language === 'zh-CN' ? `${days}天 ${hours % 24}小时` : `${days}d ${hours % 24}h`
    },
    formatPercent: (value) => `${Number.isFinite(value) ? value.toFixed(value >= 10 ? 0 : 1) : '0.0'}%`,
    formatBytes: (value) => {
      if (!Number.isFinite(value) || value <= 0) return '0 B'
      const units = ['B', 'KB', 'MB', 'GB']
      const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1_024)))
      return `${(value / 1_024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
    },
  }
}

const I18nContext = createContext<I18n>(createI18n('en'))

export function I18nProvider({ language, children }: { language: UiLanguage; children: ReactNode }) {
  const value = useMemo(() => createI18n(language), [language])
  useEffect(() => {
    document.documentElement.lang = language
  }, [language])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18n {
  return useContext(I18nContext)
}
