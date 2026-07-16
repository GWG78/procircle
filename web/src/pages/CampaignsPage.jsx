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
} from '@shopify/polaris'
import { ChevronDownIcon, ChevronUpIcon, ClipboardIcon } from '@shopify/polaris-icons'

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

function labelFor(options, value) {
  return options.find((o) => o.value === value)?.label || value
}

function formatDate(iso) {
  if (!iso) return null
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

function statusTone(status) {
  if (status === 'active') return 'success'
  if (status === 'expired') return 'warning'
  return undefined // inactive -> default/neutral badge
}

function discountSummary(campaign) {
  return campaign.discountType === 'fixed'
    ? `$${campaign.discountValue} off all products`
    : `${campaign.discountValue}% off all products`
}

function dateSummary(campaign) {
  const start = formatDate(campaign.startsAt)
  const end = formatDate(campaign.expiresAt)
  if (!start && !end) return 'No expiry'
  return `${start || 'No start date'} → ${end || 'No expiry'}`
}

function redemptionLimitSummary(campaign) {
  const total = campaign.maxRedemptions != null ? `${campaign.maxRedemptions} total` : 'Unlimited total'
  const perMember =
    campaign.maxRedemptionsPerUser != null ? `${campaign.maxRedemptionsPerUser} per member` : 'unlimited per member'
  return `${total} / ${perMember}`
}

/* ============================================================
   Campaign accordion
   ============================================================ */
function CampaignAccordion({ campaign, collections, onCopyLink }) {
  const [open, setOpen] = useState(false)

  const roleFilters = campaign.filters.filter((f) => f.filterType === 'role')
  const countryFilters = campaign.filters.filter((f) => f.filterType === 'country')
  const collectionFilters = campaign.filters.filter((f) => f.filterType === 'collection')

  const collectionTitles = collectionFilters.map((f) => {
    const match = collections.find((c) => c.id === f.value)
    return match ? match.title : f.value
  })

  return (
    <Card padding="0">
      <div style={{ padding: '1rem' }}>
        <InlineStack align="space-between" blockAlign="center">
          <InlineStack gap="300" blockAlign="center">
            <Text variant="headingSm" as="h3">
              {campaign.name}
            </Text>
            <Badge tone={statusTone(campaign.status)}>{campaign.status}</Badge>
            <Text as="span" tone="subdued">
              {campaign.confirmedRedemptions} / {campaign.maxRedemptions ?? '∞'} redemptions
            </Text>
          </InlineStack>
          <Button
            variant="tertiary"
            icon={open ? ChevronUpIcon : ChevronDownIcon}
            accessibilityLabel={open ? 'Collapse' : 'Expand'}
            onClick={() => setOpen((o) => !o)}
          />
        </InlineStack>
      </div>

      <Collapsible open={open} id={`campaign-${campaign.id}`}>
        <Divider />
        <div style={{ padding: '1rem' }}>
          <BlockStack gap="300">
            <Text as="p">
              <Text as="span" fontWeight="semibold">
                Discount:{' '}
              </Text>
              {discountSummary(campaign)}
            </Text>

            <Text as="p">
              <Text as="span" fontWeight="semibold">
                Dates:{' '}
              </Text>
              {dateSummary(campaign)}
            </Text>

            {roleFilters.length > 0 && (
              <Text as="p">
                <Text as="span" fontWeight="semibold">
                  Roles:{' '}
                </Text>
                {roleFilters.map((f) => labelFor(ROLE_OPTIONS, f.value)).join(', ')}
              </Text>
            )}

            {countryFilters.length > 0 && (
              <Text as="p">
                <Text as="span" fontWeight="semibold">
                  Countries:{' '}
                </Text>
                {countryFilters.map((f) => labelFor(COUNTRY_OPTIONS, f.value)).join(', ')}
              </Text>
            )}

            <Text as="p">
              <Text as="span" fontWeight="semibold">
                Collection restriction:{' '}
              </Text>
              {collectionTitles.length > 0 ? `Restricted to: ${collectionTitles.join(', ')}` : 'All products'}
            </Text>

            <Text as="p">
              <Text as="span" fontWeight="semibold">
                Redemption limit:{' '}
              </Text>
              {redemptionLimitSummary(campaign)}
            </Text>

            <Text as="p">{campaign.confirmedRedemptions} confirmed redemptions</Text>

            {campaign.discountLink && (
              <TextField
                label="Discount link"
                value={campaign.discountLink}
                readOnly
                autoComplete="off"
                connectedRight={
                  <Button icon={ClipboardIcon} onClick={() => onCopyLink(campaign.discountLink)}>
                    Copy
                  </Button>
                }
              />
            )}
          </BlockStack>
        </div>
      </Collapsible>
    </Card>
  )
}

/* ============================================================
   Create campaign modal
   ============================================================ */
const EMPTY_FORM = {
  name: '',
  discountType: 'percentage',
  discountValue: '',
  startDate: '',
  endDate: '',
  maxRedemptions: '',
  maxRedemptionsPerUser: '1',
  roles: [],
  countries: [],
  restrictCollections: false,
  collectionIds: [],
}

function CreateCampaignModal({ open, onClose, onCreated, collections }) {
  const [form, setForm] = useState(EMPTY_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (open) {
      setForm(EMPTY_FORM)
      setError('')
    }
  }, [open])

  const setField = useCallback((key) => (value) => setForm((f) => ({ ...f, [key]: value })), [])

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
      expiresAt: form.endDate ? `${form.endDate}T23:59:59Z` : null,
      maxRedemptions: form.maxRedemptions ? Number(form.maxRedemptions) : null,
      maxRedemptionsPerUser:
        form.maxRedemptionsPerUser === 'unlimited' ? null : Number(form.maxRedemptionsPerUser),
      filters,
    }

    setSubmitting(true)
    try {
      const res = await fetch(`/api/campaigns/create?shop=${shop}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
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
  }, [form, onCreated])

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
            <FormLayout.Group>
              <TextField
                label="Start date"
                type="date"
                value={form.startDate}
                onChange={setField('startDate')}
                autoComplete="off"
              />
              <TextField
                label="End date"
                type="date"
                value={form.endDate}
                onChange={setField('endDate')}
                autoComplete="off"
              />
            </FormLayout.Group>
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
            <Text variant="headingSm" as="h3">
              Audience filters
            </Text>

            <ChoiceList
              title="Roles"
              allowMultiple
              choices={ROLE_OPTIONS}
              selected={form.roles}
              onChange={setField('roles')}
            />
            <Text as="p" tone="subdued" variant="bodySm">
              Members must match at least one selection in each group you filter by. Leave a group unchecked to
              apply no filter for that category.
            </Text>

            <ChoiceList
              title="Countries"
              allowMultiple
              choices={COUNTRY_OPTIONS}
              selected={form.countries}
              onChange={setField('countries')}
            />
            <Text as="p" tone="subdued" variant="bodySm">
              Members must match at least one selection in each group you filter by. Leave a group unchecked to
              apply no filter for that category.
            </Text>

            <ChoiceList title="Resorts" allowMultiple choices={[]} selected={[]} onChange={() => {}} />
            <Text as="p" tone="subdued" variant="bodySm">
              Resort filtering coming soon.
            </Text>

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
   Page
   ============================================================ */
export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState([])
  const [collections, setCollections] = useState([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [toast, setToast] = useState(null)

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

  const handleCreated = useCallback(
    (campaign) => {
      setModalOpen(false)
      loadCampaigns()
      setToast({ message: 'Campaign created successfully', error: false })
    },
    [loadCampaigns]
  )

  const handleCopyLink = useCallback((link) => {
    navigator.clipboard?.writeText(link)
    setToast({ message: 'Discount link copied', error: false })
  }, [])

  const hasCampaigns = campaigns.length > 0

  return (
    <Page title="Campaigns" primaryAction={{ content: 'Create campaign', onAction: () => setModalOpen(true) }}>
      {!loading && !hasCampaigns && (
        <Card>
          <EmptyState
            heading="No campaigns yet"
            image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
          >
            <p>Create your first ProCircle campaign to start offering pro deals to ski industry members.</p>
          </EmptyState>
        </Card>
      )}

      {hasCampaigns && (
        <BlockStack gap="300">
          {campaigns.map((campaign) => (
            <CampaignAccordion
              key={campaign.id}
              campaign={campaign}
              collections={collections}
              onCopyLink={handleCopyLink}
            />
          ))}
          <div>
            <Button onClick={() => setModalOpen(true)}>Create campaign</Button>
          </div>
        </BlockStack>
      )}

      <CreateCampaignModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={handleCreated}
        collections={collections}
      />

      {toast && <Toast content={toast.message} error={toast.error} onDismiss={() => setToast(null)} />}
    </Page>
  )
}
