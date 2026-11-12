import React, { useCallback, useEffect, useState } from 'react'
import { Frame, Navigation, Spinner, Page, Card, BlockStack, Text, Button, Banner } from '@shopify/polaris'
import { HomeIcon, DiscountIcon } from '@shopify/polaris-icons'
import { useAppBridge } from '@shopify/app-bridge-react'
import SettingsPage from './pages/SettingsPage'
import CampaignsPage from './pages/CampaignsPage'
import SetupPage from './pages/SetupPage'

const shop = new URLSearchParams(window.location.search).get('shop') || ''

export default function App({ host }) {
  const shopify = useAppBridge()
  const [currentPage, setCurrentPage] = useState('campaigns')
  // null = not checked yet. This is an app-wide guard, not just a
  // first-load redirect — it re-runs on every app mount (a brand closing
  // the tab mid-setup and coming back later still gets sent to /setup),
  // and is independent of the server-side campaign-activation check in
  // routes/campaigns.mjs, which remains authoritative either way.
  const [profileComplete, setProfileComplete] = useState(null)
  // Same null-until-checked pattern, but this gate runs first: a shop with
  // no active Shopify-managed plan gets sent to Shopify's own pricing page
  // before it ever sees the setup screen (see routes/settings.mjs and
  // services/subscriptionService.js).
  const [hasActivePlan, setHasActivePlan] = useState(null)
  const [planSelectionUrl, setPlanSelectionUrl] = useState(null)

  const checkProfile = useCallback(async () => {
    try {
      const token = await shopify.idToken()
      const res = await fetch(`/api/settings?shop=${shop}`, {
        credentials: 'include',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      setHasActivePlan(!!data.hasActivePlan)
      setPlanSelectionUrl(data.planSelectionUrl || null)
      setProfileComplete(!!data.profileComplete)
    } catch {
      // Fail open on a transient load error rather than trapping the
      // merchant on a broken gate screen with no way forward — the
      // server-side check on campaign activation is the real backstop.
      setHasActivePlan(true)
      setProfileComplete(true)
    }
  }, [shopify])

  useEffect(() => {
    checkProfile()
  }, [checkProfile])

  // Top-level redirect, not an in-iframe navigation — the pricing page
  // isn't embeddable, so this must break out of the Admin iframe.
  useEffect(() => {
    if (hasActivePlan === false && planSelectionUrl) {
      window.open(planSelectionUrl, '_top')
    }
  }, [hasActivePlan, planSelectionUrl])

  const goToSettings = useCallback(() => setCurrentPage('settings'), [])

  if (profileComplete === null || hasActivePlan === null) {
    return (
      <Frame>
        <div style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
          <Spinner size="large" accessibilityLabel="Loading" />
        </div>
      </Frame>
    )
  }

  // No active Shopify-managed plan — the effect above already tried to break
  // out to Shopify's pricing page via window.open(..., '_top'), but that can
  // fail silently (popup blockers, a stale host) or never fire, so this
  // screen must stand on its own rather than assume the redirect worked.
  if (hasActivePlan === false) {
    if (!planSelectionUrl) {
      console.error('❌ No planSelectionUrl available — cannot send merchant to the Shopify pricing page')
    }

    return (
      <Frame>
        <Page>
          <BlockStack gap="400">
            {!planSelectionUrl && (
              <Banner tone="critical">
                We couldn't load the plan page. Please refresh, or contact hi@procircle.io.
              </Banner>
            )}
            <Card>
              <BlockStack gap="300">
                <Text as="h1" variant="headingLg">Choose your plan to get started</Text>
                <Text as="p" tone="subdued">
                  ProCircle is free to install. You only pay a sales commission on verified ProCircle sales.
                </Text>
                <div>
                  <Button
                    variant="primary"
                    disabled={!planSelectionUrl}
                    onClick={() => window.open(planSelectionUrl, '_top')}
                  >
                    Choose plan
                  </Button>
                </div>
              </BlockStack>
            </Card>
          </BlockStack>
        </Page>
      </Frame>
    )
  }

  if (!profileComplete) {
    return (
      <Frame>
        <SetupPage
          onComplete={() => {
            setProfileComplete(true)
            setCurrentPage('campaigns')
          }}
        />
      </Frame>
    )
  }

  const navigationMarkup = (
    <Navigation location="/">
      <Navigation.Section
        items={[
          {
            label: 'Campaigns',
            icon: DiscountIcon,
            onClick: () => setCurrentPage('campaigns'),
            selected: currentPage === 'campaigns',
          },
          {
            label: 'Settings',
            icon: HomeIcon,
            onClick: () => setCurrentPage('settings'),
            selected: currentPage === 'settings',
          },
        ]}
      />
    </Navigation>
  )

  return (
    <Frame navigation={navigationMarkup}>
      {currentPage === 'campaigns' && <CampaignsPage onGoToSettings={goToSettings} />}
      {currentPage === 'settings' && <SettingsPage planSelectionUrl={planSelectionUrl} />}
    </Frame>
  )
}
