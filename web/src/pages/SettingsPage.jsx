import React, { useCallback, useEffect, useState } from 'react'
import { Page, Card, FormLayout, TextField, Button, Toast, Text, BlockStack, DropZone, Thumbnail } from '@shopify/polaris'

const shop = new URLSearchParams(window.location.search).get('shop') || ''

export default function SettingsPage() {
  const [categoriesText, setCategoriesText] = useState('')
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState(null) // { message, error }
  const [logoFile, setLogoFile] = useState(null)
  const [uploadingLogo, setUploadingLogo] = useState(false)

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

  const handleLogoDrop = useCallback(async (_dropFiles, acceptedFiles) => {
    const file = acceptedFiles[0]
    if (!file) return
    setLogoFile(file)
    setUploadingLogo(true)
    try {
      const formData = new FormData()
      formData.append('logo', file)
      const res = await fetch(`/api/settings/logo?shop=${shop}`, {
        method: 'POST',
        credentials: 'include',
        body: formData,
      })
      const data = await res.json()
      if (!data.success) throw new Error()
      setToast({ message: 'Logo uploaded!', error: false })
    } catch {
      setToast({ message: 'Failed to upload logo', error: true })
    } finally {
      setUploadingLogo(false)
    }
  }, [])

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
          <FormLayout>
            <Text variant="headingSm" as="h3">Brand logo</Text>
            <DropZone accept="image/*" type="image" onDrop={handleLogoDrop} allowMultiple={false}>
              {logoFile ? (
                <div style={{ padding: '1rem' }}>
                  <Thumbnail source={window.URL.createObjectURL(logoFile)} alt="Logo preview" size="large" />
                </div>
              ) : (
                <DropZone.FileUpload actionHint="Accepts .jpg, .png, .svg" />
              )}
            </DropZone>
            {uploadingLogo && <Text as="p" tone="subdued">Uploading…</Text>}
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
