import React, { useCallback, useEffect, useState } from 'react'
import { Page, Card, FormLayout, TextField, Button, Toast, Text, BlockStack } from '@shopify/polaris'

const shop = new URLSearchParams(window.location.search).get('shop') || ''

export default function SettingsPage() {
  const [categoriesText, setCategoriesText] = useState('')
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
        if (cancelled) return

        const categories = Array.isArray(data.settings?.categories)
          ? data.settings.categories
          : []
        setCategoriesText(categories.join('\n'))
      } catch {
        if (!cancelled) setToast({ message: 'Failed to load settings', error: true })
      }
    }

    loadSettings()
    return () => {
      cancelled = true
    }
  }, [])

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      const categories = categoriesText
        .split('\n')
        .map((c) => c.trim())
        .filter(Boolean)

      const res = await fetch(`/api/settings?shop=${shop}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categories }),
      })

      const data = await res.json()
      if (!data.success) throw new Error()

      setToast({ message: 'Settings saved!', error: false })
    } catch {
      setToast({ message: 'Failed to save settings', error: true })
    } finally {
      setSaving(false)
    }
  }, [categoriesText])

  return (
    <Page title="ProCircle settings">
      <Card>
        <BlockStack gap="400">
          <FormLayout>
            <TextField
              label="Product category handles"
              helpText="One category handle per line."
              value={categoriesText}
              onChange={setCategoriesText}
              multiline={4}
              autoComplete="off"
            />
          </FormLayout>
          <Text variant="bodySm" as="p" tone="subdued">
            Campaign-level settings (discount value, audience filters, limits) are configured per campaign.
          </Text>
          <div>
            <Button variant="primary" loading={saving} onClick={handleSave}>
              Save settings
            </Button>
          </div>
        </BlockStack>
      </Card>

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
