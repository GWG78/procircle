import React from 'react'
import { Page, Card, Text, BlockStack } from '@shopify/polaris'
import BrandProfileForm from '../components/BrandProfileForm'

/**
 * First-run setup — shown instead of the main app (see App.jsx's guard)
 * until the shop's brand profile is complete. Reuses BrandProfileForm, the
 * same fields/API as Settings, just framed as onboarding. onComplete fires
 * only once the profile is actually complete (BrandProfileForm's Save is
 * disabled until then via requireComplete) and hands control back to App.jsx
 * to drop into the main Campaigns/Settings shell.
 */
export default function SetupPage({ onComplete }) {
  return (
    <Page title="Welcome to ProCircle — let's set up your brand profile">
      <BlockStack gap="400">
        <Card>
          <Text as="p">
            Members will see this information when they view your pro deals, and we'll use your contact email to
            let you know if a campaign is approaching its redemption limit. Fill this in once to get started.
          </Text>
        </Card>
        <BrandProfileForm submitLabel="Finish setup" requireComplete onSaveSuccess={onComplete} />
      </BlockStack>
    </Page>
  )
}
