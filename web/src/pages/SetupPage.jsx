import React from 'react'
import { Page, Text, BlockStack } from '@shopify/polaris'
import { ArrowRightIcon } from '@shopify/polaris-icons'
import BrandProfileForm from '../components/BrandProfileForm'

const eyebrowStyle = {
  textTransform: 'uppercase',
  fontSize: '0.75rem',
  letterSpacing: '0.05em',
  fontWeight: 600,
  color: 'var(--p-color-text-secondary)',
}

/**
 * First-run setup — shown instead of the main app (see App.jsx's guard)
 * until the shop's brand profile is complete. Reuses BrandProfileForm, the
 * same fields/API/intro copy as Settings, just framed as onboarding via a
 * custom heading (instead of Page's title prop) plus a footer row —
 * BrandProfileForm only renders that footer when footerNote is passed, so
 * SettingsPage's plain in-card button is unaffected. onComplete fires only
 * once the profile is actually complete (BrandProfileForm's Save is
 * disabled until then via requireComplete) and hands control back to
 * App.jsx to drop into the main Campaigns/Settings shell.
 */
export default function SetupPage({ onComplete }) {
  return (
    <Page>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <div style={eyebrowStyle}>Setup · step 1 of 2</div>
          <Text as="h1" variant="headingXl">Welcome to ProCircle — set up your brand profile</Text>
        </BlockStack>

        <BrandProfileForm
          submitLabel="Save brand profile"
          submitIcon={ArrowRightIcon}
          requireComplete
          onSaveSuccess={onComplete}
          footerNote="Next: choose the organisations you want to reach."
        />
      </BlockStack>
    </Page>
  )
}
