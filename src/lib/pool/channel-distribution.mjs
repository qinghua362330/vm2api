/**
 * 渠道分发 (channel distribution).
 *
 * sub2api resolves 用户 → 分组 → 账号池 → 选账号. In this fork the channel does
 * NOT pick an account: it answers only "which buckets (egress/IP) may this
 * request consume, and priced how". The bucket → slot → session resolution then
 * runs unchanged (session binding > bucket preference > failover).
 *
 * Keeping exactly one dispatch model is the point. A channel that also chose
 * accounts would reintroduce the second one this fork exists to remove.
 *
 * Resolution order for the allowed set:
 *   1. the API key's channel          (most specific — a key is per-consumer)
 *   2. the user's channels            (the tenant's grant)
 *   3. no channel → unconstrained     (pre-channel behaviour, unchanged)
 * then intersected with the buckets the user actually holds.
 */

import { getDb } from '../db/database.mjs'
import { ChannelsRepo } from '../db/repos/channels-repo.mjs'
import { EgressBindingsRepo } from '../db/repos/egress-bindings-repo.mjs'

/**
 * The channel a request belongs to, or null when channels are not in play.
 * `apiKeyRecord.channel_id` wins; otherwise the user's first channel.
 */
export function resolveRequestChannel(
  { apiKeyRecord = null, userId = null } = {},
  { repo = new ChannelsRepo(getDb()) } = {},
) {
  const keyChannel = Number(apiKeyRecord?.channel_id)
  if (Number.isFinite(keyChannel) && keyChannel > 0) {
    const channel = repo.get(keyChannel)
    if (channel && channel.status === 'active') return channel
  }
  const uid = String(userId || '').trim()
  if (!uid) return null
  for (const id of repo.channelsOfUser(uid)) {
    const channel = repo.get(id)
    if (channel && channel.status === 'active') return channel
  }
  return null
}

/**
 * The egress ids a request may use.
 *
 * @returns {{allowedEgressIds: string[]|null, channel: object|null, reason: string}}
 *   null means "unconstrained" — no channel applies, so the user's own buckets
 *   are the only bound and the caller already has them.
 */
export function allowedEgressesForRequest(
  { apiKeyRecord = null, userId = null, userBucketEgressIds = [] } = {},
  { repo = new ChannelsRepo(getDb()), bindingsRepo = new EgressBindingsRepo(getDb()) } = {},
) {
  const channel = resolveRequestChannel({ apiKeyRecord, userId }, { repo })
  const uid = String(userId || '').trim()
  const buckets = new Set(userBucketEgressIds || [])
  if (!uid && !channel) return { allowedEgressIds: null, channel: null, reason: 'no_scope' }

  if (!channel) {
    // No channel configured: the user's own buckets are the only constraint.
    return { allowedEgressIds: null, channel: null, reason: 'no_channel' }
  }

  const channelBuckets = repo.listBucketIds(channel.id)
  if (!channelBuckets.length) {
    // A channel with no buckets can serve nothing — say so rather than silently
    // falling back to the whole fleet.
    return { allowedEgressIds: [], channel, reason: 'channel_has_no_buckets' }
  }

  // A user with no buckets yet has not been granted anything, so the channel is
  // the grant. A user with buckets must satisfy both.
  const own = buckets.size ? [...buckets] : uid ? bindingsRepo.listBuckets(uid).map((b) => b.egress_id) : []

  if (!own.length) {
    return { allowedEgressIds: channelBuckets, channel, reason: 'channel_only' }
  }

  const allowed = channelBuckets.filter((egressId) => own.includes(egressId))
  if (!allowed.length) {
    return { allowedEgressIds: [], channel, reason: 'no_bucket_in_channel' }
  }
  return { allowedEgressIds: allowed, channel, reason: 'channel_intersect' }
}

/** Price a model under a channel. Returns null when the channel has no row for it. */
export function priceForModel(channelId, model, { repo = new ChannelsRepo(getDb()) } = {}) {
  const raw = String(model || '').trim()
  if (!raw || channelId == null) return null
  const rows = repo.listPricing(channelId)
  for (const row of rows) {
    if (row.models.includes(raw)) return row
    // dated ids (claude-haiku-4-5-20251001) match their alias entry
    if (row.models.some((entry) => raw.startsWith(`${entry}-`))) return row
  }
  return null
}

/**
 * Restrict a model list to what the channel permits.
 * `restrict_models` off means the channel lists prices but does not gate.
 */
export function modelAllowedInChannel(channel, model, { repo = new ChannelsRepo(getDb()) } = {}) {
  if (!channel || channel.restrict_models !== true) return true
  return priceForModel(channel.id, model, { repo }) != null
}

/** Console view: channels with their buckets, users and pricing. */
export function channelOverview({ repo = new ChannelsRepo(getDb()) } = {}) {
  return repo.list().map((channel) => ({
    ...channel,
    buckets: repo.listBucketIds(channel.id),
    bucket_count: repo.listBucketIds(channel.id).length,
    users: repo.listUserIds(channel.id),
    user_count: repo.listUserIds(channel.id).length,
    pricing: repo.listPricing(channel.id),
  }))
}
