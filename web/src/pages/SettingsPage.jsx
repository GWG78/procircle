import React from 'react'
import { Page, Card, BlockStack, InlineStack, Text, Button } from '@shopify/polaris'
import BrandProfileForm from '../components/BrandProfileForm'

/**
 * planSelectionUrl comes from App.jsx (GET /api/settings via
 * services/subscriptionService.js's getPlanSelectionUrl) — it resolves
 * regardless of whether the shop currently has an active plan, so it's safe
 * to use here for plan *changes*, not just the first-time App.jsx gate.
 * Opened with '_top', same reasoning as the gate screen: Shopify's pricing
 * page isn't embeddable, so this must break out of the Admin iframe.
 */
export default function SettingsPage({ planSelectionUrl }) {
  const managePlan = () => window.open(planSelectionUrl, '_top')

  return (
    <Page
      title="ProCircle settings"
      secondaryActions={[
        {
          content: 'Manage plan',
          disabled: !planSelectionUrl,
          onAction: managePlan,
        },
      ]}
    >
      <BlockStack gap="400">
        <Card>
          <InlineStack align="space-between" blockAlign="center" gap="400">
            <BlockStack gap="100">
              <Text as="h2" variant="headingMd">Plan & billing</Text>
              <Text as="p" tone="subdued">
                Commission plan — $0/month plus sales commission on verified ProCircle sales.
              </Text>
              {!planSelectionUrl && (
                <Text as="p" tone="subdued">
                  The plan page couldn't be loaded — refresh this page to try again.
                </Text>
              )}
            </BlockStack>
            <Button disabled={!planSelectionUrl} onClick={managePlan}>
              Manage plan
            </Button>
          </InlineStack>
        </Card>

        <BrandProfileForm submitLabel="Save settings" />
      </BlockStack>
    </Page>
  )
}
