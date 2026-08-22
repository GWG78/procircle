import React, { useCallback, useEffect, useState } from 'react'
import { Frame, Navigation, Spinner } from '@shopify/polaris'
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

  const checkProfile = useCallback(async () => {
    try {
      const token = await shopify.idToken()
      const res = await fetch(`/api/settings?shop=${shop}`, {
        credentials: 'include',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      setProfileComplete(!!data.profileComplete)
    } catch {
      // Fail open on a transient load error rather than trapping the
      // merchant on a broken gate screen with no way forward — the
      // server-side check on campaign activation is the real backstop.
      setProfileComplete(true)
    }
  }, [shopify])

  useEffect(() => {
    checkProfile()
  }, [checkProfile])

  const goToSettings = useCallback(() => setCurrentPage('settings'), [])

  if (profileComplete === null) {
    return (
      <Frame>
        <div style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
          <Spinner size="large" accessibilityLabel="Loading" />
        </div>
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
      {currentPage === 'settings' && <SettingsPage />}
    </Frame>
  )
}
