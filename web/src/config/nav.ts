import {
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
  Megaphone,
  Monitor,
  Puzzle,
  Network,
  ScrollText,
  Settings,
  Shield,
  Ticket,
  Users,
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
  { id: 'overview', url: '/overview', icon: LayoutDashboard },
  { id: 'cluster', url: '/cluster', icon: LayoutGrid },
  { id: 'vm', url: '/vm', icon: Monitor },
  { id: 'import', url: '/import', icon: Download },
  { id: 'usage', url: '/usage', icon: LineChart },
  { id: 'billing', url: '/billing', icon: LineChart },
  { id: 'proxies', url: '/proxies', icon: Shield },
  { id: 'egress', url: '/egress', icon: Network },
  { id: 'users', url: '/users', icon: Users },
  { id: 'channels', url: '/channels', icon: Layers },
  { id: 'redeem', url: '/redeem', icon: Ticket },
  { id: 'subscriptions', url: '/subscriptions', icon: CalendarClock },
  { id: 'announcements', url: '/announcements', icon: Megaphone },
  { id: 'payments', url: '/payments', icon: CreditCard },
  { id: 'models', url: '/models', icon: List },
  { id: 'loadtest', url: '/loadtest/reports', icon: Gauge },
  { id: 'protocol', url: '/protocol', icon: Box },
  { id: 'keys', url: '/keys', icon: KeyRound },
  { id: 'logs', url: '/logs', icon: ScrollText },
  { id: 'database', url: '/database', icon: Database },
  { id: 'settings', url: '/settings/sticky', icon: Settings },
  { id: 'wrap', url: '/wrap', icon: Puzzle },
]
