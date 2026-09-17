import { createFileRoute } from '@tanstack/react-router'
import { PaymentsPage } from '@/features/payments'

export const Route = createFileRoute('/_authenticated/payments')({
  component: PaymentsPage,
})
