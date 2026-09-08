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
  Checkbox,
  ChoiceList,
  Banner,
  Toast,
  Divider,
  Tooltip,
  Spinner,
  Tag,
  Popover,
  ActionList,
  Icon,
} from '@shopify/polaris'
import { ChevronRightIcon, CalendarIcon, PlusIcon } from '@shopify/polaris-icons'
import { useAppBridge } from '@shopify/app-bridge-react'

const shop = new URLSearchParams(window.location.search).get('shop') || ''

// Shared design-token styles for the create campaign modal — see
// web/src/styles/tokens.css for the underlying custom-property values.
const modalTitleStyle = {
  fontFamily: 'var(--font-sans)',
  fontSize: 'var(--fs-h2)',
  fontWeight: 'var(--fw-semibold)',
  color: 'var(--text-primary)',
  lineHeight: 1.2,
  margin: '0 0 var(--space-3) 0',
}

const subtitleStyle = {
  fontFamily: 'var(--font-sans)',
  fontSize: 'var(--fs-body-sm)',
  color: 'var(--text-secondary)',
  margin: '0 0 var(--space-8) 0',
}

const sectionLabelStyle = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-eyebrow)',
  fontWeight: 'var(--fw-medium)',
  letterSpacing: 'var(--tr-eyebrow)',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
  marginBottom: 'var(--space-5)',
}

const sectionDividerStyle = {
  borderTop: '1px solid var(--border-subtle)',
  margin: 'var(--space-9) 0',
}

const fieldWrapStyle = {
  marginBottom: 'var(--space-7)',
}

const helperTextStyle = {
  fontFamily: 'var(--font-sans)',
  fontSize: 'var(--fs-caption)',
  color: 'var(--text-muted)',
  marginTop: 'var(--space-2)',
}

const optionalTextStyle = {
  fontFamily: 'var(--font-sans)',
  fontSize: 'var(--fs-caption)',
  fontWeight: 400,
  color: 'var(--text-muted)',
  marginLeft: 'var(--space-2)',
}

// Shared collapsed-row chrome for the Audience and Collection restriction
// panels — the two must look identical when collapsed (Step 3).
const panelToggleRowStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  width: '100%',
  boxSizing: 'border-box',
  padding: 'var(--space-5) var(--space-6)',
  background: 'var(--bg-sunken)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-3)',
  fontFamily: 'var(--font-sans)',
  fontSize: 'var(--fs-body-sm)',
  fontWeight: 'var(--fw-medium)',
  color: 'var(--text-primary)',
}

const panelExpandedStyle = {
  padding: 'var(--space-6)',
  boxSizing: 'border-box',
  borderLeft: '1px solid var(--border-subtle)',
  borderRight: '1px solid var(--border-subtle)',
  borderBottom: '1px solid var(--border-subtle)',
  borderBottomLeftRadius: 'var(--radius-3)',
  borderBottomRightRadius: 'var(--radius-3)',
  background: 'var(--bg-surface)',
}

function chevronStyle(open) {
  return {
    display: 'inline-flex',
    transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
    transition: 'transform 0.15s ease',
  }
}

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

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

// "cap_reached", "paused", and "ended" already have their own Badge tone/
// label (see STATUS_TONES/STATUS_LABELS) — this line is only for the two
// states the badge alone doesn't fully explain: whether an active campaign
// is actually live yet, and when a draft goes live.
function statusLine(campaign) {
  if (campaign.status === 'active') {
    return 'Live — members can now access this deal on procircle.io'
  }
  if (campaign.status === 'draft') {
    return `Draft — goes live on ${formatDate(campaign.startsAt)}`
  }
  return null
}

/* ============================================================
   Create campaign modal
   ============================================================ */
const EMPTY_FORM = {
  name: '',
  discountValue: '',
  startDate: '',
  validForDays: '30',
  maxRedemptions: '',
  maxRedemptionsPerUser: '1',
  maxRedemptionsPerUserUnlimited: false,
  roles: [],
  countries: [],
  collectionIds: [],
}

const EMPTY_ACTIVE_FILTERS = { role: [], country: [], resort: [] }

function CreateCampaignModal({ open, onClose, onCreated, onGoToSettings, collections }) {
  const shopify = useAppBridge()
  const [form, setForm] = useState(EMPTY_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [profileIncomplete, setProfileIncomplete] = useState(false)
  const [activeFilters, setActiveFilters] = useState(EMPTY_ACTIVE_FILTERS)
  const [refineOpen, setRefineOpen] = useState(false)
  const [collectionsOpen, setCollectionsOpen] = useState(false)
  const [audienceCount, setAudienceCount] = useState(null)
  const [audienceLoading, setAudienceLoading] = useState(false)
  const [collectionPickerOpen, setCollectionPickerOpen] = useState(false)

  useEffect(() => {
    if (open) {
      setForm(EMPTY_FORM)
      setError('')
      setProfileIncomplete(false)
      setActiveFilters(EMPTY_ACTIVE_FILTERS)
      setRefineOpen(false)
      setCollectionsOpen(false)
      setCollectionPickerOpen(false)

      shopify
        .idToken()
        .then((token) =>
          fetch(`/api/campaigns/active-filters?shop=${shop}`, {
            credentials: 'include',
            headers: { Authorization: `Bearer ${token}` },
          })
        )
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
  }, [open, shopify])

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
      setError('Discount percentage must be a positive number.')
      return
    }

    const validForDaysNum = Number(form.validForDays)
    if (!form.validForDays || isNaN(validForDaysNum) || validForDaysNum < 30) {
      setError('Minimum validity window is 30 days')
      return
    }

    const maxPerMemberNum = Number(form.maxRedemptionsPerUser)
    if (
      !form.maxRedemptionsPerUserUnlimited &&
      (!form.maxRedemptionsPerUser || isNaN(maxPerMemberNum) || maxPerMemberNum <= 0)
    ) {
      setError('Max per member must be a positive number.')
      return
    }

    const filters = [
      ...form.roles.map((value) => ({ filterType: 'role', value })),
      ...form.countries.map((value) => ({ filterType: 'country', value })),
      ...form.collectionIds.map((value) => ({ filterType: 'collection', value })),
    ]

    const payload = {
      name: form.name.trim(),
      discountType: 'percentage',
      discountValue: discountValueNum,
      startsAt: form.startDate ? `${form.startDate}T00:00:00Z` : null,
      validForDays: validForDaysNum,
      maxRedemptions: form.maxRedemptions ? Number(form.maxRedemptions) : null,
      maxRedemptionsPerUser: form.maxRedemptionsPerUserUnlimited ? null : maxPerMemberNum,
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
        setProfileIncomplete(data.code === 'PROFILE_INCOMPLETE')
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

  const selectedCollections = form.collectionIds.map((id) => collections.find((c) => c.id === id)).filter(Boolean)
  const availableCollections = collections.filter((c) => !form.collectionIds.includes(c.id))

  const matchLabel =
    audienceCount !== null ? `~${audienceCount} member${audienceCount === 1 ? '' : 's'} match` : 'Counting…'

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create campaign"
      titleHidden
      primaryAction={{
        content: 'Create campaign',
        onAction: handleSubmit,
        loading: submitting,
      }}
      secondaryActions={[{ content: 'Cancel', onAction: onClose, disabled: submitting }]}
    >
      <Modal.Section>
        <div>
          <h2 style={modalTitleStyle}>Create campaign</h2>
          <p style={subtitleStyle}>Set the discount, dates and limits. Nothing goes live until you publish it.</p>

          {error && (
            <div style={fieldWrapStyle}>
              <Banner
                tone="critical"
                action={
                  profileIncomplete
                    ? {
                        content: 'Go to Settings',
                        onAction: () => {
                          onClose()
                          onGoToSettings?.()
                        },
                      }
                    : undefined
                }
              >
                {error}
              </Banner>
            </div>
          )}

          <div style={sectionLabelStyle}>Basic details</div>
          <div style={fieldWrapStyle}>
            <TextField
              label="Campaign name"
              placeholder="Winter guide programme"
              value={form.name}
              onChange={setField('name')}
              autoComplete="off"
              requiredIndicator
            />
            <div style={helperTextStyle}>Shown to pros in their deal list.</div>
          </div>
          <div style={fieldWrapStyle}>
            <TextField
              label="Discount percentage"
              type="number"
              min={1}
              suffix="%"
              placeholder="40"
              value={form.discountValue}
              onChange={setField('discountValue')}
              autoComplete="off"
              requiredIndicator
            />
            <div style={helperTextStyle}>Applied to full-price items in the selected collections.</div>
          </div>

          <div style={sectionDividerStyle} />
          <div style={sectionLabelStyle}>Dates & limits</div>
          <div style={fieldWrapStyle}>
            <TextField
              label="Campaign start date"
              type="date"
              prefix={<Icon source={CalendarIcon} tone="subdued" />}
              value={form.startDate}
              onChange={setField('startDate')}
              autoComplete="off"
            />
            <div style={helperTextStyle}>
              Leave blank to start immediately. A future date shows as Draft until it arrives.
            </div>
          </div>
          <div style={fieldWrapStyle}>
            <TextField
              label="Member validity window (days)"
              type="number"
              min={30}
              value={form.validForDays}
              onChange={setField('validForDays')}
              autoComplete="off"
              requiredIndicator
            />
            <div style={helperTextStyle}>
              Members will have this many days to use the deal after claiming it. Minimum 30 days.
            </div>
          </div>
          <div style={fieldWrapStyle}>
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
              <BlockStack gap="200">
                <TextField
                  label="Max per member"
                  type="number"
                  min={1}
                  value={form.maxRedemptionsPerUser}
                  onChange={setField('maxRedemptionsPerUser')}
                  autoComplete="off"
                  disabled={form.maxRedemptionsPerUserUnlimited}
                />
                <Checkbox
                  label="Unlimited"
                  checked={form.maxRedemptionsPerUserUnlimited}
                  onChange={setField('maxRedemptionsPerUserUnlimited')}
                />
              </BlockStack>
            </FormLayout.Group>
          </div>

          <div style={sectionDividerStyle} />
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 'var(--space-5)',
            }}
          >
            <div style={{ ...sectionLabelStyle, marginBottom: 0 }}>Audience</div>
            <InlineStack gap="200" blockAlign="center">
              <span style={{ padding: '4px 8px', display: 'inline-flex' }}>
                <Tag>{matchLabel}</Tag>
              </span>
              {audienceLoading && <Spinner size="small" />}
            </InlineStack>
          </div>

          <div style={fieldWrapStyle}>
            <div
              role="button"
              tabIndex={0}
              aria-expanded={refineOpen}
              aria-controls="refine-audience"
              onClick={() => setRefineOpen((o) => !o)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setRefineOpen((o) => !o)
                }
              }}
              style={panelToggleRowStyle}
            >
              <span>
                Refine audience <span style={optionalTextStyle}>— optional</span>
              </span>
              <span style={chevronStyle(refineOpen)}>
                <Icon source={ChevronRightIcon} tone="subdued" />
              </span>
            </div>

            <Collapsible open={refineOpen} id="refine-audience">
              <div style={panelExpandedStyle}>
                <BlockStack gap="300">
                  <Text as="p" tone="subdued" variant="bodySm">
                    Select the roles and regions you want this campaign to reach. Leave everything unchecked to
                    reach all verified members.
                  </Text>
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
                </BlockStack>
              </div>
            </Collapsible>
          </div>

          <div style={sectionDividerStyle} />
          <div style={sectionLabelStyle}>Collection restriction</div>
          <div style={fieldWrapStyle}>
            <div
              role="button"
              tabIndex={0}
              aria-expanded={collectionsOpen}
              aria-controls="collection-restriction"
              onClick={() => setCollectionsOpen((o) => !o)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setCollectionsOpen((o) => !o)
                }
              }}
              style={panelToggleRowStyle}
            >
              <span>
                Restrict to specific collections <span style={optionalTextStyle}>— optional</span>
              </span>
              <span style={chevronStyle(collectionsOpen)}>
                <Icon source={ChevronRightIcon} tone="subdued" />
              </span>
            </div>

            <Collapsible open={collectionsOpen} id="collection-restriction">
              <div style={panelExpandedStyle}>
                <BlockStack gap="200">
                  <div style={helperTextStyle}>
                    Select the collections you want this discount to apply to. Leave unchecked to apply across your
                    full catalogue.
                  </div>
                  {selectedCollections.length > 0 && (
                    <InlineStack gap="200">
                      {selectedCollections.map((c) => (
                        <Tag
                          key={c.id}
                          onRemove={() => setField('collectionIds')(form.collectionIds.filter((id) => id !== c.id))}
                        >
                          {c.title}
                        </Tag>
                      ))}
                    </InlineStack>
                  )}
                  <div>
                    <Popover
                      active={collectionPickerOpen}
                      onClose={() => setCollectionPickerOpen(false)}
                      activator={
                        <Button
                          variant="plain"
                          icon={PlusIcon}
                          onClick={() => setCollectionPickerOpen((o) => !o)}
                          disabled={availableCollections.length === 0}
                        >
                          Add collection
                        </Button>
                      }
                    >
                      <ActionList
                        allowFiltering
                        filterLabel="Search collections"
                        items={availableCollections.map((c) => ({
                          content: `${c.title} (${c.productCount})`,
                          onAction: () => {
                            setField('collectionIds')([...form.collectionIds, c.id])
                            setCollectionPickerOpen(false)
                          },
                        }))}
                      />
                    </Popover>
                  </div>
                </BlockStack>
              </div>
            </Collapsible>
          </div>
        </div>
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
   Edit campaign modal
   ============================================================ */
const EMPTY_EDIT_FORM = { name: '', maxRedemptions: '', roles: [], countries: [] }

function filtersToEditForm(campaign) {
  return {
    name: campaign.name,
    maxRedemptions: campaign.maxRedemptions != null ? String(campaign.maxRedemptions) : '',
    roles: campaign.filters.filter((f) => f.filterType === 'role').map((f) => f.value),
    countries: campaign.filters.filter((f) => f.filterType === 'country').map((f) => f.value),
  }
}

function sameValues(a, b) {
  if (a.length !== b.length) return false
  const sortedA = [...a].sort()
  const sortedB = [...b].sort()
  return sortedA.every((v, i) => v === sortedB[i])
}

function EditCampaignModal({ campaign, collections, onClose, onSaved }) {
  const shopify = useAppBridge()
  const [form, setForm] = useState(EMPTY_EDIT_FORM)
  const [initial, setInitial] = useState(EMPTY_EDIT_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!campaign) return
    const next = filtersToEditForm(campaign)
    setForm(next)
    setInitial(next)
    setError('')
  }, [campaign])

  const setField = useCallback((key) => (value) => setForm((f) => ({ ...f, [key]: value })), [])

  const handleSubmit = useCallback(async () => {
    setError('')

    if (!form.name.trim()) {
      setError('Campaign name is required.')
      return
    }
    if (form.maxRedemptions && (isNaN(Number(form.maxRedemptions)) || Number(form.maxRedemptions) <= 0)) {
      setError('Max total redemptions must be a positive number.')
      return
    }

    const payload = {}
    if (form.name.trim() !== initial.name) payload.name = form.name.trim()
    if (form.maxRedemptions !== initial.maxRedemptions) {
      payload.maxRedemptions = form.maxRedemptions ? Number(form.maxRedemptions) : null
    }
    if (!sameValues(form.roles, initial.roles)) payload.roles = form.roles
    if (!sameValues(form.countries, initial.countries)) payload.regions = form.countries

    if (Object.keys(payload).length === 0) {
      onClose()
      return
    }

    setSubmitting(true)
    try {
      const token = await shopify.idToken()
      const res = await fetch(`/api/campaigns/${campaign.id}?shop=${shop}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      })
      const data = await res.json()

      if (res.status === 409) {
        setError(data.message || 'Audience conflict — resolve it before saving.')
        return
      }
      if (!data.success) {
        setError(data.error || 'Failed to save changes.')
        return
      }

      onSaved(data.campaign)
    } catch {
      setError('Failed to save changes.')
    } finally {
      setSubmitting(false)
    }
  }, [form, initial, campaign, onSaved, onClose, shopify])

  return (
    <Modal
      open={!!campaign}
      onClose={onClose}
      title={`Edit "${campaign?.name}"`}
      primaryAction={{ content: 'Save changes', onAction: handleSubmit, loading: submitting }}
      secondaryActions={[{ content: 'Cancel', onAction: onClose, disabled: submitting }]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          {error && <Banner tone="critical">{error}</Banner>}

          <FormLayout>
            <TextField
              label="Campaign name"
              value={form.name}
              onChange={setField('name')}
              autoComplete="off"
              requiredIndicator
            />
            <TextField
              label="Max total redemptions"
              type="number"
              min={1}
              placeholder="Unlimited"
              value={form.maxRedemptions}
              onChange={setField('maxRedemptions')}
              autoComplete="off"
            />

            <Divider />
            <ChoiceList
              title="Roles"
              allowMultiple
              choices={ROLE_OPTIONS}
              selected={form.roles}
              onChange={setField('roles')}
            />
            <ChoiceList
              title="Countries"
              allowMultiple
              choices={COUNTRY_OPTIONS}
              selected={form.countries}
              onChange={setField('countries')}
            />

            <Divider />
            <Text variant="headingSm" as="h3">
              Fixed at creation
            </Text>
            <Text as="p" tone="subdued" variant="bodySm">
              These can't be changed after a campaign is created.
            </Text>
            <Text as="p">Discount: {campaign?.discountValue}%</Text>
            <Text as="p">Collection: {campaign && collectionSummary(campaign, collections)}</Text>
          </FormLayout>
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

function CampaignRowCard({ campaign, collections, onPauseResume, onEndRequested, onEditRequested, loading }) {
  const canPause = campaign.status === 'active' || campaign.status === 'cap_reached' || campaign.status === 'draft'
  const canResume = campaign.status === 'paused'
  const canEnd = campaign.status !== 'ended'
  const canEdit = campaign.status !== 'ended'

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

            {statusLine(campaign) && (
              <Text as="p" tone="subdued" variant="bodySm">
                {statusLine(campaign)}
              </Text>
            )}

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
            {canEdit && (
              <Button size="slim" onClick={() => onEditRequested(campaign)}>
                Edit
              </Button>
            )}
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

function CampaignsList({ campaigns, collections, onPauseResume, onEndRequested, onEditRequested, actionLoadingId }) {
  return (
    <BlockStack gap="300">
      {campaigns.map((campaign) => (
        <CampaignRowCard
          key={campaign.id}
          campaign={campaign}
          collections={collections}
          onPauseResume={onPauseResume}
          onEndRequested={onEndRequested}
          onEditRequested={onEditRequested}
          loading={actionLoadingId === campaign.id}
        />
      ))}
    </BlockStack>
  )
}

/* ============================================================
   Page
   ============================================================ */
export default function CampaignsPage({ onGoToSettings }) {
  const [campaigns, setCampaigns] = useState([])
  const [collections, setCollections] = useState([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [endingCampaign, setEndingCampaign] = useState(null)
  const [editingCampaign, setEditingCampaign] = useState(null)
  const [actionLoadingId, setActionLoadingId] = useState(null)
  const [toast, setToast] = useState(null)
  const shopify = useAppBridge()

  const loadCampaigns = useCallback(async () => {
    try {
      const token = await shopify.idToken()
      const res = await fetch(`/api/campaigns?shop=${shop}`, {
        credentials: 'include',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) setCampaigns(data.campaigns)
    } catch {
      setToast({ message: 'Failed to load campaigns', error: true })
    }
  }, [shopify])

  const loadCollections = useCallback(async () => {
    try {
      const token = await shopify.idToken()
      const res = await fetch(`/api/collections?shop=${shop}`, {
        credentials: 'include',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      if (data.success) setCollections(data.collections)
    } catch {
      // Non-fatal — collection restriction just won't be selectable.
    }
  }, [shopify])

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
          setToast({
            message: data.error || `Failed to ${action} campaign`,
            error: true,
            action:
              data.code === 'PROFILE_INCOMPLETE' && onGoToSettings
                ? { content: 'Go to Settings', onAction: onGoToSettings }
                : undefined,
          })
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
    [shopify, onGoToSettings]
  )

  const handleEnded = useCallback((updatedCampaign) => {
    setCampaigns((prev) => prev.map((c) => (c.id === updatedCampaign.id ? updatedCampaign : c)))
    setEndingCampaign(null)
    setToast({ message: 'Campaign ended', error: false })
  }, [])

  const handleToastError = useCallback((message) => {
    setToast({ message, error: true })
  }, [])

  const handleSaved = useCallback((updatedCampaign) => {
    setCampaigns((prev) => prev.map((c) => (c.id === updatedCampaign.id ? updatedCampaign : c)))
    setEditingCampaign(null)
    setToast({ message: 'Campaign updated', error: false })
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
            onEditRequested={setEditingCampaign}
            actionLoadingId={actionLoadingId}
          />
        </BlockStack>
      )}

      <CreateCampaignModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={handleCreated}
        onGoToSettings={onGoToSettings}
        collections={collections}
      />

      <EndCampaignModal
        campaign={endingCampaign}
        onClose={() => setEndingCampaign(null)}
        onEnded={handleEnded}
        onToastError={handleToastError}
      />

      <EditCampaignModal
        campaign={editingCampaign}
        collections={collections}
        onClose={() => setEditingCampaign(null)}
        onSaved={handleSaved}
      />

      {toast && (
        <Toast content={toast.message} error={toast.error} action={toast.action} onDismiss={() => setToast(null)} />
      )}
    </Page>
  )
}
