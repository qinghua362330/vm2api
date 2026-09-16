import { createFileRoute } from '@tanstack/react-router'
import { RedeemPage } from '@/features/redeem'

export const Route = createFileRoute('/_authenticated/redeem')({
  component: RedeemPage,
})
