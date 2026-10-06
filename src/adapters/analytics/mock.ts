import type {
  AnalyticsConnector,
  DiscoveredEvent,
  DiscoveredPerson,
  SiteAnalyticsConfig,
  SyncResult,
} from './interface';

export class MockAnalyticsConnector implements AnalyticsConnector {
  readonly name = 'mock';

  public mockPersons: DiscoveredPerson[] = [];
  public mockEvents: DiscoveredEvent[] = [];
  public shouldFail = false;
  public failureMessage = 'Simulated analytics sync failure';

  async sync(config: SiteAnalyticsConfig): Promise<SyncResult> {
    if (this.shouldFail) {
      return {
        success: false,
        persons: [],
        events: [],
        errors: [this.failureMessage],
      };
    }

    return {
      success: true,
      persons: [...this.mockPersons],
      events: [...this.mockEvents],
      newCursor: new Date().toISOString(),
    };
  }
}
