import { createFileRoute } from '@tanstack/react-router'
import { WalletPage } from '@/features/wallet'

export const Route = createFileRoute('/_authenticated/wallet')({
  component: WalletPage,
})
