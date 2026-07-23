import React, { useCallback, useEffect, useState } from 'react'
import {
  Page,
  Card,
  EmptyState,
  Collapsible,
  Badge,
  Text,
  BlockStack,
  InlineStack,
  Button,
  Modal,
  FormLayout,
  TextField,
  Select,
  Checkbox,
  ChoiceList,
  Banner,
  Toast,
  Divider,
  Tooltip,
  Spinner,
} from '@shopify/polaris'
import { ChevronDownIcon, ChevronUpIcon, ClipboardIcon } from '@shopify/polaris-icons'
import { useAppBridge } from '@shopify/app-bridge-react'

const shop = new URLSearchParams(window.location.search).get('shop') || ''

const ROLE_OPTIONS = [
  { value: 'ski_instructor', label: 'Ski Instructor' },
  { value: 'snowboard_instructor', label: 'Snowboard Instructor' },
  { value: 'ski_patrol', label: 'Ski Patrol' },
  { value: 'shop_worker', label: 'Ski Shop Worker' },
  { value: 'resort_staff', label: 'Resort Staff' },
  { value: 'coach', label: 'Coach / Trainer' },
]

const COUNTRY_OPTIONS = [
  { value: 'FR', label: 'France' },
  { value: 'AT', label: 'Austria' },
  { value: 'CH', label: 'Switzerland' },
  { value: 'IT', label: 'Italy' },
  { value: 'DE', label: 'Germany' },
  { value: 'GB', label: 'United Kingdom' },
  { value: 'NO', label: 'Norway' },
  { value: 'SE', label: 'Sweden' },
  { value: 'US', label: 'United States' },
  { value: 'CA', label: 'Canada' },
  { value: 'NZ', label: 'New Zealand' },
  { value: 'AU', label: 'Australia' },
  { value: 'JP', label: 'Japan' },
]

const MAX_PER_MEMBER_OPTIONS = [
  { label: '1', value: '1' },
  { label: '2', value: '2' },
  { label: '5', value: '5' },
  { label: 'Unlimited', value: 'unlimited' },
]

const STATUS_LABELS = {
  draft: 'Draft',
  active: 'Active',
  cap_reached: 'Cap Reached',
  paused: 'Paused',
  ended: 'Ended',
}

const STATUS_TONES = {
  draft: 'info',
  active: 'success',
  cap_reached: 'attention',
  paused: 'warning',
  ended: undefined,
}

function labelFor(options, value) {
  return options.find((o) => o.value === value)?.label || value
}

function rolesSummary(campaign) {
  const values = campaign.filters.filter((f) => f.filterType === 'role').map((f) => labelFor(ROLE_OPTIONS, f.value))
  return values.length ? values.join(', ') : 'All roles'
}

function regionsSummary(campaign) {
  const values = campaign.filters.filter((f) => f.filterType === 'country').map((f) => f.value)
  return values.length ? values.join(', ') : 'All regions'
}

function collectionSummary(campaign, collections) {
  const values = campaign.filters.filter((f) => f.filterType === 'collection')
  if (!values.length) return 'All products'
  return values.map((f) => collections.find((c) => c.id === f.value)?.title || f.value).join(', ')
}

function formatRevenue(amount) {
  return `$${Number(amount || 0).toFixed(2)}`
}

/* ============================================================
   Create campaign modal
   ============================================================ */
const EMPTY_FORM = {
  name: '',
  discountType: 'percentage',
  discountValue: '',
  startDate: '',
  validForDays: '30',
  maxRedemptions: '',
  maxRedemptionsPerUser: '1',
  roles: [],
  countries: [],
  restrictCollections: false,
  collectionIds: [],
}

const EMPTY_ACTIVE_FILTERS = { role: [], country: [], resort: [] }

function CreateCampaignModal({ open, onClose, onCreated, collections }) {
  const shopify = useAppBridge()
  const [form, setForm] = useState(EMPTY_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [activeFilters, setActiveFilters] = useState(EMPTY_ACTIVE_FILTERS)
  const [refineOpen, setRefineOpen] = useState(false)
  const [audienceCount, setAudienceCount] = useState(null)
  const [audienceLoading, setAudienceLoading] = useState(false)

  useEffect(() => {
    if (open) {
      setForm(EMPTY_FORM)
      setError('')
      setActiveFilters(EMPTY_ACTIVE_FILTERS)
      setRefineOpen(false)

      fetch(`/api/campaigns/active-filters?shop=${shop}`, { credentials: 'include' })
        .then((res) => res.json())
        .then((data) => {
          if (data.success) {
            setActiveFilters({ role: data.role || [], country: data.country || [], resort: data.resort || [] })
          }
        })
        .catch(() => {
          // Non-fatal — the form just won't grey out any options.
        })
    }
  }, [open])

  // Live audience-size counter — fires once on open (showing the full
  // verified-member count when nothing is selected) and again on every
  // role/country change, debounced so rapid checkbox clicks don't spam
  // the endpoint.
  useEffect(() => {
    if (!open) return

    setAudienceLoading(true)
    const timer = setTimeout(async () => {
      try {
        const filters = [
          ...form.roles.map((value) => ({ filterType: 'role', value })),
          ...form.countries.map((value) => ({ filterType: 'country', value })),
        ]
        const token = await shopify.idToken()
        const res = await fetch(`/api/campaigns/preview-audience-size?shop=${shop}`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ filters }),
        })
        const data = await res.json()
        if (data.success) setAudienceCount(data.count)
      } catch {
        // Non-fatal — the counter just won't update this round.
      } finally {
        setAudienceLoading(false)
      }
    }, 300)

    return () => clearTimeout(timer)
  }, [open, form.roles, form.countries, shopify])

  const setField = useCallback((key) => (value) => setForm((f) => ({ ...f, [key]: value })), [])

  // Loose conflict rule for the create form (approximate — uses the flat
  // active-filter sets, not per-campaign overlap; see server-side
  // checkAudienceConflict for the authoritative check run on resume).
  // A country is greyed out once at least one selected role also appears
  // somewhere in the active role set; a role is greyed out once at least
  // one selected country also appears somewhere in the active country set.
  // Neither dimension is greyed until the other has a selection.
  const rolesOverlapActive = form.roles.some((r) => activeFilters.role.includes(r))
  const countriesOverlapActive = form.countries.some((c) => activeFilters.country.includes(c))

  const greyedCountries = form.roles.length > 0 && rolesOverlapActive ? new Set(activeFilters.country) : new Set()
  const greyedRoles = form.countries.length > 0 && countriesOverlapActive ? new Set(activeFilters.role) : new Set()

  const roleChoices = ROLE_OPTIONS.map((opt) => {
    const disabled = greyedRoles.has(opt.value)
    return {
      value: opt.value,
      disabled,
      label: disabled ? (
        <Tooltip content="Already targeted by an active campaign">
          <span>{opt.label}</span>
        </Tooltip>
      ) : (
        opt.label
      ),
    }
  })

  const countryChoices = COUNTRY_OPTIONS.map((opt) => {
    const disabled = greyedCountries.has(opt.value)
    return {
      value: opt.value,
      disabled,
      label: disabled ? (
        <Tooltip content="Already targeted by an active campaign">
          <span>{opt.label}</span>
        </Tooltip>
      ) : (
        opt.label
      ),
    }
  })

  const handleSubmit = useCallback(async () => {
    setError('')

    if (!form.name.trim()) {
      setError('Campaign name is required.')
      return
    }
    const discountValueNum = Number(form.discountValue)
    if (!form.discountValue || isNaN(discountValueNum) || discountValueNum <= 0) {
      setError('Discount value must be a positive number.')
      return
    }

    const validForDaysNum = Number(form.validForDays)
    if (!form.validForDays || isNaN(validForDaysNum) || validForDaysNum < 30) {
      setError('Minimum validity window is 30 days')
      return
    }

    const filters = [
      ...form.roles.map((value) => ({ filterType: 'role', value })),
      ...form.countries.map((value) => ({ filterType: 'country', value })),
      ...(form.restrictCollections ? form.collectionIds.map((value) => ({ filterType: 'collection', value })) : []),
    ]

    const payload = {
      name: form.name.trim(),
      discountType: form.discountType,
      discountValue: discountValueNum,
      startsAt: form.startDate ? `${form.startDate}T00:00:00Z` : null,
      validForDays: validForDaysNum,
      maxRedemptions: form.maxRedemptions ? Number(form.maxRedemptions) : null,
      maxRedemptionsPerUser:
        form.maxRedemptionsPerUser === 'unlimited' ? null : Number(form.maxRedemptionsPerUser),
      filters,
    }

    setSubmitting(true)
    try {
      const token = await shopify.idToken()
      const res = await fetch(`/api/campaigns/create?shop=${shop}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      })
      const data = await res.json()

      if (!data.success) {
        setError(data.error || 'Failed to create campaign.')
        return
      }

      onCreated(data.campaign)
    } catch {
      setError('Failed to create campaign.')
    } finally {
      setSubmitting(false)
    }
  }, [form, onCreated, shopify])

  const shownCollections = collections.length

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create campaign"
      primaryAction={{
        content: 'Create campaign',
        onAction: handleSubmit,
        loading: submitting,
      }}
      secondaryActions={[{ content: 'Cancel', onAction: onClose, disabled: submitting }]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          {error && <Banner tone="critical">{error}</Banner>}

          <FormLayout>
            <Text variant="headingSm" as="h3">
              Basic details
            </Text>
            <TextField
              label="Campaign name"
              value={form.name}
              onChange={setField('name')}
              autoComplete="off"
              requiredIndicator
            />
            <FormLayout.Group>
              <Select
                label="Discount type"
                options={[
                  { label: 'Percentage off', value: 'percentage' },
                  { label: 'Fixed amount off', value: 'fixed' },
                ]}
                value={form.discountType}
                onChange={setField('discountType')}
              />
              <TextField
                label="Discount value"
                type="number"
                min={1}
                value={form.discountValue}
                onChange={setField('discountValue')}
                autoComplete="off"
                requiredIndicator
              />
            </FormLayout.Group>

            <Divider />
            <Text variant="headingSm" as="h3">
              Dates & limits
            </Text>
            <TextField
              label="Campaign start date"
              type="date"
              helpText="Leave blank to start immediately. A future date shows as Draft until it arrives."
              value={form.startDate}
              onChange={setField('startDate')}
              autoComplete="off"
            />
            <TextField
              label="Member validity window (days)"
              type="number"
              min={30}
              helpText="Members will have this many days to use the deal after claiming it. Minimum 30 days."
              value={form.validForDays}
              onChange={setField('validForDays')}
              autoComplete="off"
              requiredIndicator
            />
            <FormLayout.Group>
              <TextField
                label="Max total redemptions"
                type="number"
                min={1}
                placeholder="Unlimited"
                value={form.maxRedemptions}
                onChange={setField('maxRedemptions')}
                autoComplete="off"
              />
              <Select
                label="Max per member"
                options={MAX_PER_MEMBER_OPTIONS}
                value={form.maxRedemptionsPerUser}
                onChange={setField('maxRedemptionsPerUser')}
              />
            </FormLayout.Group>

            <Divider />

            <InlineStack gap="200" blockAlign="center">
              <Text as="span" tone="subdued" variant="bodySm">
                {audienceLoading && audienceCount === null
                  ? 'Counting matching members…'
                  : audienceCount !== null
                  ? `~${audienceCount} member${audienceCount === 1 ? '' : 's'} match`
                  : ''}
              </Text>
              {audienceLoading && <Spinner size="small" />}
            </InlineStack>

            <div>
              <Button
                variant="tertiary"
                icon={refineOpen ? ChevronUpIcon : ChevronDownIcon}
                onClick={() => setRefineOpen((o) => !o)}
              >
                Refine audience (optional)
              </Button>
              {!refineOpen && (
                <Text as="p" tone="subdued" variant="bodySm">
                  Leave this closed to reach all verified members.
                </Text>
              )}
            </div>

            <Collapsible open={refineOpen} id="refine-audience">
              <BlockStack gap="300">
                <ChoiceList
                  title="Roles"
                  allowMultiple
                  choices={roleChoices}
                  selected={form.roles}
                  onChange={setField('roles')}
                />
                <ChoiceList
                  title="Countries"
                  allowMultiple
                  choices={countryChoices}
                  selected={form.countries}
                  onChange={setField('countries')}
                />
                <Text as="p" tone="subdued" variant="bodySm">
                  Members must match at least one selection in each group you filter by. Leave a group unchecked to
                  apply no filter for that category.
                </Text>
              </BlockStack>
            </Collapsible>

            <Divider />
            <Text variant="headingSm" as="h3">
              Collection restriction
            </Text>
            <Checkbox
              label="Restrict to specific collections"
              checked={form.restrictCollections}
              onChange={setField('restrictCollections')}
            />
            {form.restrictCollections && (
              <BlockStack gap="200">
                <Text as="p" tone="subdued" variant="bodySm">
                  Showing {shownCollections} of {shownCollections} collections
                </Text>
                <div style={{ maxHeight: '300px', overflowY: 'auto', border: '1px solid var(--p-color-border)', borderRadius: '8px', padding: '0.5rem' }}>
                  <ChoiceList
                    allowMultiple
                    titleHidden
                    choices={collections.map((c) => ({
                      value: c.id,
                      label: `${c.title} (${c.productCount})`,
                    }))}
                    selected={form.collectionIds}
                    onChange={setField('collectionIds')}
                  />
                </div>
              </BlockStack>
            )}
          </FormLayout>
        </BlockStack>
      </Modal.Section>
    </Modal>
  )
}

/* ============================================================
   End Campaign confirmation modal
   ============================================================ */
function EndCampaignModal({ campaign, onClose, onEnded, onToastError }) {
  const shopify = useAppBridge()
  const [claimedCount, setClaimedCount] = useState(null)
  const [loadingCount, setLoadingCount] = useState(true)
  const [ending, setEnding] = useState(false)

  useEffect(() => {
    if (!campaign) return
    setLoadingCount(true)
    setClaimedCount(null)
    ;(async () => {
      try {
        const token = await shopify.idToken()
        const res = await fetch(`/api/campaigns/${campaign.id}/claimed-count?shop=${shop}`, {
          credentials: 'include',
          headers: { Authorization: `Bearer ${token}` },
        })
        const data = await res.json()
        if (data.success) setClaimedCount(data.count)
      } catch {
        // Leave claimedCount null — the modal shows generic copy instead.
      } finally {
        setLoadingCount(false)
      }
    })()
  }, [campaign, shopify])

  const handleEnd = useCallback(async () => {
    setEnding(true)
    try {
      const token = await shopify.idToken()
      const res = await fetch(`/api/campaigns/${campaign.id}/end?shop=${shop}`, {
        method: 'POST',
        credentials: 'include',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (!data.success) {
        onToastError(data.error || 'Failed to end campaign')
        return
      }
      onEnded(data.campaign)
    } catch {
      onToastError('Failed to end campaign')
    } finally {
      setEnding(false)
    }
  }, [campaign, onEnded, onToastError, shopify])

  return (
    <Modal
      open={!!campaign}
      onClose={onClose}
      title={`End "${campaign?.name}"?`}
      primaryAction={{
        content: 'End campaign',
        destructive: true,
        onAction: handleEnd,
        loading: ending,
        disabled: loadingCount,
      }}
      secondaryActions={[{ content: 'Cancel', onAction: onClose, disabled: ending }]}
    >
      <Modal.Section>
        <BlockStack gap="300">
          {loadingCount ? (
            <InlineStack gap="200" blockAlign="center">
              <Spinner size="small" />
              <Text as="span">Checking claimed codes…</Text>
            </InlineStack>
          ) : (
            <Banner tone="warning">
              {claimedCount != null
                ? `${claimedCount} member${claimedCount === 1 ? '' : 's'} have this code but haven't used it yet. Ending the campaign now will invalidate it for them.`
                : "Ending the campaign now will invalidate its discount code for anyone who claimed it but hasn't used it yet."}
            </Banner>
          )}
          <Text as="p" tone="subdued">
            This can't be undone — a new campaign will be needed to relaunch.
          </Text>
        </BlockStack>
      </Modal.Section>
    </Modal>
  )
}

/* ============================================================
   Campaigns list — each campaign is a bordered card split into a left
   info zone and a right stats/actions zone by a vertical divider. Column
   headers for the right zone's stats repeat inside every card, above
   that card's stats sub-row.
   ============================================================ */
const LEFT_ZONE_FLEX = '3 3 0'
const RIGHT_ZONE_FLEX = '2 2 0'

function CampaignRowCard({ campaign, collections, onPauseResume, onEndRequested, onCopyLink, loading }) {
  const canPause = campaign.status === 'active' || campaign.status === 'cap_reached' || campaign.status === 'draft'
  const canResume = campaign.status === 'paused'
  const canEnd = campaign.status !== 'ended'

  return (
    <Card padding="0">
      <div style={{ display: 'flex' }}>
        <div style={{ flex: LEFT_ZONE_FLEX, padding: '1rem' }}>
          <BlockStack gap="400">
            <InlineStack gap="200" blockAlign="center">
              <Text as="span" fontWeight="semibold" variant="headingSm">
                {campaign.name}
              </Text>
              <Badge tone={STATUS_TONES[campaign.status]}>{STATUS_LABELS[campaign.status] || campaign.status}</Badge>
            </InlineStack>

            <BlockStack gap="100">
              <Text as="p" tone="subdued" variant="bodySm">
                Roles: {rolesSummary(campaign)}
              </Text>
              <Text as="p" tone="subdued" variant="bodySm">
                Regions: {regionsSummary(campaign)}
              </Text>
              <Text as="p" tone="subdued" variant="bodySm">
                Collection: {collectionSummary(campaign, collections)}
              </Text>
            </BlockStack>

            {campaign.discountLink && (
              <div>
                <Button icon={ClipboardIcon} onClick={() => onCopyLink(campaign)}>
                  Copy discount link
                </Button>
              </div>
            )}
          </BlockStack>
        </div>

        <div style={{ width: '1px', backgroundColor: 'var(--p-color-border)' }} />

        <div style={{ flex: RIGHT_ZONE_FLEX, padding: '1rem', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)' }}>
              <Text as="span" tone="subdued" variant="bodySm" fontWeight="medium">
                Sales
              </Text>
              <Text as="span" tone="subdued" variant="bodySm" fontWeight="medium">
                Revenue
              </Text>
              <Text as="span" tone="subdued" variant="bodySm" fontWeight="medium">
                Redemption cap
              </Text>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)' }}>
              <Text as="span">{campaign.salesCount}</Text>
              <Text as="span">{formatRevenue(campaign.salesRevenue)}</Text>
              <Text as="span">
                {campaign.confirmedRedemptions} / {campaign.maxRedemptions ?? '∞'}
              </Text>
            </div>
          </div>

          <InlineStack gap="200" align="end">
            {canPause && (
              <Button size="slim" loading={loading} onClick={() => onPauseResume(campaign, 'pause')}>
                Pause
              </Button>
            )}
            {canResume && (
              <Button size="slim" loading={loading} onClick={() => onPauseResume(campaign, 'resume')}>
                Resume
              </Button>
            )}
            {canEnd && (
              <Button size="slim" tone="critical" onClick={() => onEndRequested(campaign)}>
                End
              </Button>
            )}
          </InlineStack>
        </div>
      </div>
    </Card>
  )
}

function CampaignsList({ campaigns, collections, onPauseResume, onEndRequested, onCopyLink, actionLoadingId }) {
  return (
    <BlockStack gap="300">
      {campaigns.map((campaign) => (
        <CampaignRowCard
          key={campaign.id}
          campaign={campaign}
          collections={collections}
          onPauseResume={onPauseResume}
          onEndRequested={onEndRequested}
          onCopyLink={onCopyLink}
          loading={actionLoadingId === campaign.id}
        />
      ))}
    </BlockStack>
  )
}

/* ============================================================
   Page
   ============================================================ */
export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState([])
  const [collections, setCollections] = useState([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [endingCampaign, setEndingCampaign] = useState(null)
  const [actionLoadingId, setActionLoadingId] = useState(null)
  const [toast, setToast] = useState(null)
  const shopify = useAppBridge()

  const loadCampaigns = useCallback(async () => {
    try {
      const res = await fetch(`/api/campaigns?shop=${shop}`, { credentials: 'include' })
      const data = await res.json()
      if (data.success) setCampaigns(data.campaigns)
    } catch {
      setToast({ message: 'Failed to load campaigns', error: true })
    }
  }, [])

  const loadCollections = useCallback(async () => {
    try {
      const res = await fetch(`/api/collections?shop=${shop}`, { credentials: 'include' })
      const data = await res.json()
      if (data.success) setCollections(data.collections)
    } catch {
      // Non-fatal — collection restriction just won't be selectable.
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    Promise.all([loadCampaigns(), loadCollections()]).finally(() => setLoading(false))
  }, [loadCampaigns, loadCollections])

  const handleCreated = useCallback(() => {
    setModalOpen(false)
    loadCampaigns()
    setToast({ message: 'Campaign created successfully', error: false })
  }, [loadCampaigns])

  const handleOpenCreate = useCallback(() => {
    setModalOpen(true)
  }, [])

  const handleCopyLink = useCallback((campaign) => {
    navigator.clipboard?.writeText(campaign.discountLink)
    setToast({ message: 'Discount link copied', error: false })
  }, [])

  const handlePauseResume = useCallback(
    async (campaign, action) => {
      setActionLoadingId(campaign.id)
      try {
        const token = await shopify.idToken()
        const res = await fetch(`/api/campaigns/${campaign.id}/${action}?shop=${shop}`, {
          method: 'POST',
          credentials: 'include',
          headers: { Authorization: `Bearer ${token}` },
        })
        const data = await res.json()

        if (res.status === 409) {
          setToast({ message: data.message || 'Audience conflict — resolve it before resuming', error: true })
          return
        }
        if (!data.success) {
          setToast({ message: data.error || `Failed to ${action} campaign`, error: true })
          return
        }

        setCampaigns((prev) => prev.map((c) => (c.id === data.campaign.id ? data.campaign : c)))
        setToast({ message: action === 'pause' ? 'Campaign paused' : 'Campaign resumed', error: false })
      } catch {
        setToast({ message: `Failed to ${action} campaign`, error: true })
      } finally {
        setActionLoadingId(null)
      }
    },
    [shopify]
  )

  const handleEnded = useCallback((updatedCampaign) => {
    setCampaigns((prev) => prev.map((c) => (c.id === updatedCampaign.id ? updatedCampaign : c)))
    setEndingCampaign(null)
    setToast({ message: 'Campaign ended', error: false })
  }, [])

  const handleToastError = useCallback((message) => {
    setToast({ message, error: true })
  }, [])

  const hasCampaigns = campaigns.length > 0
  const activeCount = campaigns.filter((c) => c.status === 'active' || c.status === 'cap_reached').length

  return (
    <Page
      title="Campaigns"
      primaryAction={
        hasCampaigns ? { content: 'Add campaign', onAction: handleOpenCreate } : undefined
      }
    >
      {!loading && !hasCampaigns && (
        <Card>
          <EmptyState
            heading="No campaigns yet"
            image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
            action={{ content: 'Create your first campaign', onAction: handleOpenCreate }}
          >
            <p>Create your first ProCircle campaign to start offering pro deals to ski industry members.</p>
          </EmptyState>
        </Card>
      )}

      {hasCampaigns && (
        <BlockStack gap="300">
          <Text as="p" tone="subdued">
            {activeCount} active campaign{activeCount === 1 ? '' : 's'}
          </Text>
          <CampaignsList
            campaigns={campaigns}
            collections={collections}
            onPauseResume={handlePauseResume}
            onEndRequested={setEndingCampaign}
            onCopyLink={handleCopyLink}
            actionLoadingId={actionLoadingId}
          />
        </BlockStack>
      )}

      <CreateCampaignModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={handleCreated}
        collections={collections}
      />

      <EndCampaignModal
        campaign={endingCampaign}
        onClose={() => setEndingCampaign(null)}
        onEnded={handleEnded}
        onToastError={handleToastError}
      />

      {toast && <Toast content={toast.message} error={toast.error} onDismiss={() => setToast(null)} />}
    </Page>
  )
}
