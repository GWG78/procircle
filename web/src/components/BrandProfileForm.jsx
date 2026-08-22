import React, { useCallback, useEffect, useState } from 'react'
import { Card, FormLayout, TextField, Button, Toast, Text, BlockStack, DropZone, Thumbnail } from '@shopify/polaris'
import { useAppBridge } from '@shopify/app-bridge-react'

const shop = new URLSearchParams(window.location.search).get('shop') || ''

const BRAND_DESCRIPTION_MAX_LENGTH = 300
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * The brand profile fields (logo, description, contact) shared by
 * SettingsPage and SetupPage — same underlying ShopSettings data via the
 * same GET/POST /api/settings and POST /api/settings/logo calls, so the two
 * screens can never drift into separate copies of this data.
 *
 * requireComplete gates the Save button on description/contactName/
 * contactEmail all being present and contactEmail being valid (used by
 * SetupPage, which must not let a merchant through with an incomplete
 * profile). SettingsPage leaves it off — editing just the logo, for
 * instance, shouldn't be blocked by an unrelated missing field.
 */
export default function BrandProfileForm({ submitLabel, onSaveSuccess, requireComplete = false }) {
  const shopify = useAppBridge()
  const [loaded, setLoaded] = useState(false)
  const [description, setDescription] = useState('')
  const [contactName, setContactName] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [emailError, setEmailError] = useState('')
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState(null) // { message, error }
  const [logoFile, setLogoFile] = useState(null)
  const [uploadingLogo, setUploadingLogo] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function loadSettings() {
      try {
        const token = await shopify.idToken()
        const res = await fetch(`/api/settings?shop=${shop}`, {
          credentials: 'include',
          headers: { Authorization: `Bearer ${token}` },
        })
        const data = await res.json()
        if (cancelled) return

        setDescription(data.settings?.description || '')
        setContactName(data.settings?.contactName || '')
        setContactEmail(data.settings?.contactEmail || '')
      } catch {
        if (!cancelled) setToast({ message: 'Failed to load settings', error: true })
      } finally {
        if (!cancelled) setLoaded(true)
      }
    }

    loadSettings()
    return () => {
      cancelled = true
    }
  }, [shopify])

  const handleEmailChange = useCallback((value) => {
    setContactEmail(value)
    setEmailError('')
  }, [])

  const handleSave = useCallback(async () => {
    const trimmedEmail = contactEmail.trim()
    if (trimmedEmail && !EMAIL_PATTERN.test(trimmedEmail)) {
      setEmailError('Enter a valid email address')
      return
    }
    setEmailError('')

    setSaving(true)
    try {
      const token = await shopify.idToken()
      const res = await fetch(`/api/settings?shop=${shop}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          description: description.trim(),
          contactName: contactName.trim(),
          contactEmail: trimmedEmail,
        }),
      })

      const data = await res.json()
      if (!data.success) {
        setEmailError(data.error?.includes('email') ? data.error : '')
        throw new Error(data.error)
      }

      setToast({ message: 'Settings saved!', error: false })
      onSaveSuccess?.(data.settings)
    } catch {
      setToast({ message: 'Failed to save settings', error: true })
    } finally {
      setSaving(false)
    }
  }, [description, contactName, contactEmail, onSaveSuccess, shopify])

  const handleLogoDrop = useCallback(async (_dropFiles, acceptedFiles) => {
    const file = acceptedFiles[0]
    if (!file) return
    setLogoFile(file)
    setUploadingLogo(true)
    try {
      const token = await shopify.idToken()
      const formData = new FormData()
      formData.append('logo', file)
      const res = await fetch(`/api/settings/logo?shop=${shop}`, {
        method: 'POST',
        credentials: 'include',
        headers: { Authorization: `Bearer ${token}` },
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
  }, [shopify])

  const trimmedEmailValid = contactEmail.trim() && EMAIL_PATTERN.test(contactEmail.trim())
  const complete = !!(description.trim() && contactName.trim() && trimmedEmailValid)
  const canSubmit = !requireComplete || complete

  return (
    <>
      <Card>
        <BlockStack gap="400">
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

          <FormLayout>
            <TextField
              label="Brand description"
              value={description}
              onChange={setDescription}
              multiline={4}
              maxLength={BRAND_DESCRIPTION_MAX_LENGTH}
              showCharacterCount
              autoComplete="off"
              requiredIndicator
              placeholder="e.g. Forward Outdoor makes technical ski and mountain apparel designed for instructors and guides who spend all day outside."
              helpText="Shown to members on the ProCircle site who may not be familiar with your brand."
            />
          </FormLayout>

          <FormLayout>
            <Text variant="headingSm" as="h3">Contact</Text>
            <FormLayout.Group>
              <TextField
                label="Contact name"
                value={contactName}
                onChange={setContactName}
                autoComplete="off"
                requiredIndicator
              />
              <TextField
                label="Contact email"
                type="email"
                value={contactEmail}
                onChange={handleEmailChange}
                autoComplete="off"
                requiredIndicator
                error={emailError}
              />
            </FormLayout.Group>
            <Text as="p" tone="subdued" variant="bodySm">
              We'll email this address if one of your campaigns is approaching its redemption limit, so you can
              raise the limit or start a new campaign.
            </Text>
          </FormLayout>

          <div>
            <Button variant="primary" loading={saving} disabled={!loaded || !canSubmit} onClick={handleSave}>
              {submitLabel}
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
    </>
  )
}
