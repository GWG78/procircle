import React, { useState } from 'react'
import { Frame, Navigation } from '@shopify/polaris'
import { HomeIcon, DiscountIcon } from '@shopify/polaris-icons'
import SettingsPage from './pages/SettingsPage'
import CampaignsPage from './pages/CampaignsPage'

export default function App({ host }) {
  const [currentPage, setCurrentPage] = useState('campaigns')

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
      {currentPage === 'campaigns' && <CampaignsPage />}
      {currentPage === 'settings' && <SettingsPage />}
    </Frame>
  )
}
