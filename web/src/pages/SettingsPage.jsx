import React, { useCallback, useEffect, useState } from 'react'
import {
  Page,
  Card,
  FormLayout,
  TextField,
  Select,
  Checkbox,
  Button,
  Toast,
  Text,
  BlockStack,
  InlineGrid,
} from '@shopify/polaris'

const ALLOWED_COUNTRIES = [
  { value: 'UK', label: 'United Kingdom' },
  { value: 'CH', label: 'Switzerland' },
  { value: 'FR', label: 'France' },
  { value: 'IT', label: 'Italy' },
  { value: 'DE', label: 'Germany' },
  { value: 'AT', label: 'Austria' },
]

const ALLOWED_MEMBER_TYPES = [
  { value: 'instructor', label: 'Instructor' },
  { value: 'club_member', label: 'Club Member' },
  { value: 'competitor', label: 'Competitor' },
  { value: 'mountain_guide', label: 'Mountain Guide' },
]

const shop = new URLSearchParams(window.location.search).get('shop') || ''

export default function SettingsPage() {
  const [discountType, setDiscountType] = useState('percentage')
  const [discountValue, setDiscountValue] = useState('20')
  const [expiryDays, setExpiryDays] = useState('')
  const [maxDiscounts, setMaxDiscounts] = useState('')
  const [oneTimeUse, setOneTimeUse] = useState(true)
  const [allowedCountries, setAllowedCountries] = useState(
    ALLOWED_COUNTRIES.map((c) => c.value)
  )
  const [allowedMemberTypes, setAllowedMemberTypes] = useState(
    ALLOWED_MEMBER_TYPES.map((m) => m.value)
  )

  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState(null) // { message, error }

  useEffect(() => {
    let cancelled = false

    async function loadSettings() {
      try {
        const res = await fetch(`/api/settings?shop=${shop}`, {
          credentials: 'include',
        })
        const data = await res.json()
        const s = data.settings || {}
        if (cancelled) return

        setDiscountType(s.discountType || 'percentage')
        setDiscountValue(String(s.discountValue ?? 20))
        setExpiryDays(s.expiryDays != null ? String(s.expiryDays) : '')
        setMaxDiscounts(s.maxDiscounts != null ? String(s.maxDiscounts) : '')
        setOneTimeUse(s.oneTimeUse !== false)
        if (Array.isArray(s.allowedCountries) && s.allowedCountries.length) {
          setAllowedCountries(s.allowedCountries)
        }
        if (Array.isArray(s.allowedMemberTypes) && s.allowedMemberTypes.length) {
          setAllowedMemberTypes(s.allowedMemberTypes)
        }
      } catch {
        if (!cancelled) setToast({ message: 'Failed to load settings', error: true })
      }
    }

    loadSettings()
    return () => {
      cancelled = true
    }
  }, [])

  const toggleCountry = useCallback((value) => {
    setAllowedCountries((prev) =>
      prev.includes(value) ? prev.filter((c) => c !== value) : [...prev, value]
    )
  }, [])

  const toggleMemberType = useCallback((value) => {
    setAllowedMemberTypes((prev) =>
      prev.includes(value) ? prev.filter((m) => m !== value) : [...prev, value]
    )
  }, [])

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      const payload = {
        discountType,
        discountValue: Number(discountValue),
        expiryDays: expiryDays ? Number(expiryDays) : null,
        maxDiscounts: maxDiscounts ? Number(maxDiscounts) : null,
        oneTimeUse,
        allowedCountries,
        allowedMemberTypes,
      }

      const res = await fetch(`/api/settings?shop=${shop}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      const data = await res.json()
      if (!data.success) throw new Error()

      setToast({ message: 'Settings saved!', error: false })
    } catch {
      setToast({ message: 'Failed to save settings', error: true })
    } finally {
      setSaving(false)
    }
  }, [discountType, discountValue, expiryDays, maxDiscounts, oneTimeUse, allowedCountries, allowedMemberTypes])

  return (
    <Page
      title="ProCircle settings"
      subtitle="Control who can claim discounts and how codes are generated."
    >
      <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
        <Card>
          <BlockStack gap="400">
            <Text variant="headingSm" as="h2" tone="subdued">
              DISCOUNT RULES
            </Text>
            <FormLayout>
              <Select
                label="Discount type"
                options={[
                  { label: 'Percentage (%)', value: 'percentage' },
                  { label: 'Fixed amount', value: 'fixed' },
                ]}
                value={discountType}
                onChange={setDiscountType}
              />
              <TextField
                label="Discount value"
                type="number"
                min={1}
                value={discountValue}
                onChange={setDiscountValue}
                autoComplete="off"
              />
              <TextField
                label="Expiry window (days)"
                type="number"
                min={1}
                value={expiryDays}
                onChange={setExpiryDays}
                autoComplete="off"
              />
              <TextField
                label="Max number of codes"
                type="number"
                min={1}
                value={maxDiscounts}
                onChange={setMaxDiscounts}
                autoComplete="off"
              />
              <Checkbox
                label="One-time use per code"
                checked={oneTimeUse}
                onChange={setOneTimeUse}
              />
            </FormLayout>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="400">
            <Text variant="headingSm" as="h2" tone="subdued">
              ALLOWED COUNTRIES
            </Text>
            <BlockStack gap="200">
              {ALLOWED_COUNTRIES.map((c) => (
                <Checkbox
                  key={c.value}
                  label={c.label}
                  checked={allowedCountries.includes(c.value)}
                  onChange={() => toggleCountry(c.value)}
                />
              ))}
            </BlockStack>

            <Text variant="headingSm" as="h2" tone="subdued">
              ALLOWED MEMBER TYPES
            </Text>
            <BlockStack gap="200">
              {ALLOWED_MEMBER_TYPES.map((m) => (
                <Checkbox
                  key={m.value}
                  label={m.label}
                  checked={allowedMemberTypes.includes(m.value)}
                  onChange={() => toggleMemberType(m.value)}
                />
              ))}
            </BlockStack>
          </BlockStack>
        </Card>
      </InlineGrid>

      <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem' }}>
        <Button variant="primary" loading={saving} onClick={handleSave}>
          Save settings
        </Button>
        <Button onClick={() => window.open('https://procircle.io', '_blank')}>
          Setup guide
        </Button>
      </div>

      {toast && (
        <Toast
          content={toast.message}
          error={toast.error}
          onDismiss={() => setToast(null)}
        />
      )}
    </Page>
  )
}
