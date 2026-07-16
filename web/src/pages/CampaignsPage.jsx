import React from 'react'
import { Page, Card, EmptyState } from '@shopify/polaris'

export default function CampaignsPage() {
  return (
    <Page
      title="Campaigns"
      primaryAction={{ content: 'Create campaign', disabled: true }}
    >
      <Card>
        <EmptyState
          heading="No campaigns yet"
          image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
        >
          <p>Create your first ProCircle campaign to start offering pro deals to ski industry members.</p>
        </EmptyState>
      </Card>
    </Page>
  )
}
