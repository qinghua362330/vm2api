import { createFileRoute } from '@tanstack/react-router'
import { LedgerPage } from '@/features/ledger'

export const Route = createFileRoute('/_authenticated/ledger')({
  component: LedgerPage,
})
