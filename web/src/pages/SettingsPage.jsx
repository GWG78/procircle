import React from 'react'
import { Page } from '@shopify/polaris'
import BrandProfileForm from '../components/BrandProfileForm'

export default function SettingsPage() {
  return (
    <Page title="ProCircle settings">
      <BrandProfileForm submitLabel="Save settings" />
    </Page>
  )
}
