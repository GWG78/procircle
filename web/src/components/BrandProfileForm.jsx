import React, { useCallback, useEffect, useState } from 'react'
import {
  Card,
  FormLayout,
  TextField,
  Button,
  Toast,
  Text,
  BlockStack,
  InlineStack,
  DropZone,
  Thumbnail,
  Icon,
} from '@shopify/polaris'
import { ImageIcon } from '@shopify/polaris-icons'
import { useAppBridge } from '@shopify/app-bridge-react'

const sectionLabelStyle = {
  textTransform: 'uppercase',
  fontSize: '0.75rem',
  letterSpacing: '0.05em',
  fontWeight: 600,
  color: 'var(--p-color-text-secondary)',
}

const requiredAsterisk = (
  <Text as="span" tone="critical">
    {' *'}
  </Text>
)

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
 *
 * footerNote/submitIcon are optional and only passed by SetupPage — they
 * swap the in-card Save button for a footer row (caption + Save) below the
 * card. Omitting them (as SettingsPage does) keeps the plain in-card button
 * untouched.
 */
export default function BrandProfileForm({
  submitLabel,
  submitIcon,
  footerNote,
  onSaveSuccess,
  requireComplete = false,
}) {
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

    // TEMPORARY diagnostic — isolates token acquisition from the rest of
    // the save flow and logs the real failure reason instead of letting it
    // fall into the generic catch below silently. Remove once the
    // "missing session token" bug is confirmed fixed.
    let token
    try {
      token = await shopify.idToken()
    } catch (err) {
      console.error('[BrandProfileForm] shopify.idToken() failed:', err)
      setToast({ message: 'Failed to save settings', error: true })
      setSaving(false)
      return
    }

    try {
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
    } catch (err) {
      console.error('[BrandProfileForm] save request failed:', err)
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

    // TEMPORARY diagnostic — see handleSave above for why this is split out.
    let token
    try {
      token = await shopify.idToken()
    } catch (err) {
      console.error('[BrandProfileForm] shopify.idToken() failed (logo upload):', err)
      setToast({ message: 'Failed to upload logo', error: true })
      setUploadingLogo(false)
      return
    }

    try {
      const formData = new FormData()
      formData.append('logo', file)
      const res = await fetch(`/api/settings/logo?shop=${shop}`, {
        method: 'POST',
        credentials: 'include',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      })
      const data = await res.json()
      if (!data.success) throw new Error(data.error || 'Logo upload failed')
      setToast({ message: 'Logo uploaded!', error: false })
    } catch (err) {
      console.error('[BrandProfileForm] logo upload request failed:', err)
      setToast({ message: 'Failed to upload logo', error: true })
    } finally {
      setUploadingLogo(false)
    }
  }, [shopify])

  const trimmedEmailValid = contactEmail.trim() && EMAIL_PATTERN.test(contactEmail.trim())
  const complete = !!(description.trim() && contactName.trim() && trimmedEmailValid)
  const canSubmit = !requireComplete || complete

  return (
    <BlockStack gap="400">
      <Card>
        <Text as="p">
          Your logo and brand description are shown to members browsing your pro deals. Your contact details are
          kept private — we'll only use them to let you know if a campaign is approaching its redemption limit.
        </Text>
      </Card>

      <Card>
        <BlockStack gap="400">
          <FormLayout>
            <div style={sectionLabelStyle}>Brand logo</div>
            <DropZone accept="image/*" type="image" onDrop={handleLogoDrop} allowMultiple={false}>
              <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', padding: '1rem' }}>
                <div
                  style={{
                    width: '88px',
                    height: '88px',
                    flexShrink: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: '8px',
                    background: 'var(--p-color-bg-surface-secondary)',
                    overflow: 'hidden',
                  }}
                >
                  {logoFile ? (
                    <Thumbnail source={window.URL.createObjectURL(logoFile)} alt="Logo preview" size="large" />
                  ) : (
                    <Icon source={ImageIcon} tone="subdued" />
                  )}
                </div>
                <BlockStack gap="200">
                  <Text as="p" tone="subdued" variant="bodySm">
                    Square or horizontal, at least 400px wide, on a transparent or white background.
                  </Text>
                  <InlineStack gap="200" blockAlign="center">
                    <Button>Add image</Button>
                    <Text as="span" tone="subdued" variant="bodySm">.jpg .png .svg</Text>
                  </InlineStack>
                </BlockStack>
              </div>
            </DropZone>
            {uploadingLogo && <Text as="p" tone="subdued">Uploading…</Text>}
          </FormLayout>

          <FormLayout>
            <TextField
              label={<>Brand description{requiredAsterisk}</>}
              value={description}
              onChange={setDescription}
              multiline={4}
              maxLength={BRAND_DESCRIPTION_MAX_LENGTH}
              showCharacterCount
              autoComplete="off"
              placeholder="We make technical ski and outdoor apparel designed for guides and instructors who spend all day outside."
              helpText="A brief description of your brand and what you sell."
            />
          </FormLayout>

          <FormLayout>
            <div style={sectionLabelStyle}>Contact</div>
            <FormLayout.Group>
              <TextField
                label={<>Contact name{requiredAsterisk}</>}
                value={contactName}
                onChange={setContactName}
                autoComplete="off"
                placeholder="Full name"
                helpText="Who we contact about campaign limits."
              />
              <TextField
                label={<>Contact email{requiredAsterisk}</>}
                type="email"
                value={contactEmail}
                onChange={handleEmailChange}
                autoComplete="off"
                placeholder="name@brand.com"
                helpText="Kept private, never shown to pros."
                error={emailError}
              />
            </FormLayout.Group>
          </FormLayout>

          {!footerNote && (
            <div>
              <Button variant="primary" loading={saving} disabled={!loaded || !canSubmit} onClick={handleSave}>
                {submitLabel}
              </Button>
            </div>
          )}
        </BlockStack>
      </Card>

      {footerNote && (
        <InlineStack align="space-between" blockAlign="center" gap="400">
          <Text as="p" tone="subdued" variant="bodySm">{footerNote}</Text>
          <Button variant="primary" icon={submitIcon} loading={saving} disabled={!loaded || !canSubmit} onClick={handleSave}>
            {submitLabel}
          </Button>
        </InlineStack>
      )}

      {toast && (
        <Toast
          content={toast.message}
          error={toast.error}
          onDismiss={() => setToast(null)}
        />
      )}
    </BlockStack>
  )
}
