import {
  Activity,
  Box,
  CalendarClock,
  CreditCard,
  Database,
  Download,
  Gauge,
  KeyRound,
  LayoutDashboard,
  Layers,
  LayoutGrid,
  LineChart,
  List,
  Receipt,
  Megaphone,
  Monitor,
  Puzzle,
  Network,
  ScrollText,
  Settings,
  Shield,
  ShieldCheck,
  Ticket,
  TrendingUp,
  Users,
  Wallet,
} from 'lucide-react'

export type ViewId =
  | 'overview'
  | 'cluster'
  | 'vm'
  | 'import'
  | 'usage'
  | 'billing'
  | 'proxies'
  | 'egress'
  | 'users'
  | 'channels'
  | 'redeem'
  | 'subscriptions'
  | 'announcements'
  | 'payments'
  | 'wallet'
  | 'ledger'
  | 'audit'
  | 'channel-monitor'
  | 'ops'
  | 'models'
  | 'loadtest'
  | 'protocol'
  | 'keys'
  | 'api'
  | 'logs'
  | 'database'
  | 'settings'
  | 'wrap'

export const VIEW_TITLES: Record<ViewId, string> = {
  overview: '总览',
  cluster: '集群',
  vm: '虚拟机',
  import: '导入',
  usage: '用量',
  billing: '计费',
  proxies: '代理池',
  egress: '出口绑定',
  users: '用户',
  channels: '渠道',
  redeem: '兑换码',
  subscriptions: '订阅',
  announcements: '公告',
  payments: '充值订单',
  wallet: '我的钱包',
  ledger: '余额流水',
  audit: '审计日志',
  'channel-monitor': '渠道监控',
  ops: '运营大盘',
  models: '模型',
  loadtest: '压测',
  protocol: '协议',
  keys: '密钥',
  api: 'API',
  logs: '日志',
  database: '数据库',
  settings: '设置',
  wrap: 'Wrap 母样本',
}

export const NAV_ITEMS: {
  id: ViewId
  url: string
  icon: typeof LayoutDashboard
}[] = [
  // 顺序就是操作顺序：先备出口，再开槽，再导凭证，然后才是渠道/用户/账。
  // 侧边栏分组（components/layout/sidebar-data.ts）按同一顺序渲染。
  { id: 'overview', url: '/overview', icon: LayoutDashboard },
  // 接入：一条 SOCKS5 = 一个出口 IP；槽必须绑着出口才能起；凭证进槽
  { id: 'proxies', url: '/proxies', icon: Shield },
  { id: 'vm', url: '/vm', icon: Monitor },
  { id: 'import', url: '/import', icon: Download },
  { id: 'cluster', url: '/cluster', icon: LayoutGrid },
  // 分发：渠道挑桶、出口绑定决定用户落在哪个 IP、用户是最终主体
  { id: 'channels', url: '/channels', icon: Layers },
  { id: 'egress', url: '/egress', icon: Network },
  { id: 'users', url: '/users', icon: Users },
  // 运营
  { id: 'usage', url: '/usage', icon: LineChart },
  { id: 'billing', url: '/billing', icon: LineChart },
  { id: 'channel-monitor', url: '/channel-monitor', icon: Activity },
  { id: 'ops', url: '/ops', icon: TrendingUp },
  { id: 'audit', url: '/audit', icon: ShieldCheck },
  { id: 'logs', url: '/logs', icon: ScrollText },
  { id: 'announcements', url: '/announcements', icon: Megaphone },
  // 账
  { id: 'redeem', url: '/redeem', icon: Ticket },
  { id: 'subscriptions', url: '/subscriptions', icon: CalendarClock },
  { id: 'payments', url: '/payments', icon: CreditCard },
  { id: 'ledger', url: '/ledger', icon: Receipt },
  { id: 'wallet', url: '/wallet', icon: Wallet },
  // 配置
  { id: 'models', url: '/models', icon: List },
  { id: 'protocol', url: '/protocol', icon: Box },
  { id: 'keys', url: '/keys', icon: KeyRound },
  { id: 'database', url: '/database', icon: Database },
  { id: 'settings', url: '/settings/sticky', icon: Settings },
  { id: 'loadtest', url: '/loadtest/reports', icon: Gauge },
  { id: 'wrap', url: '/wrap', icon: Puzzle },
]
