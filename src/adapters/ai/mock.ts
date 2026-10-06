import type { AIDecisionResult } from '../../types';
import type { AIProvider, PersonContext, SitePromptContext } from './interface';

export class MockAIProvider implements AIProvider {
  public mockResult: AIDecisionResult = {
    decision: 'send',
    reason: 'Mock AI reason: strong signal on pricing page',
    persona: 'Mock Evaluator',
    confidence: 0.85,
    subject: 'Mock Subject: checking in',
    body: 'Hi,\n\nSaw you were checking out our platform.\n\nWould you like a quick walkthrough?\n\nBest,\nYehuda',
  };

  public calls: Array<{ siteContext: SitePromptContext; personContext: PersonContext }> = [];

  async decideAndDraft(
    siteContext: SitePromptContext,
    personContext: PersonContext,
    _modelName?: string
  ): Promise<AIDecisionResult> {
    this.calls.push({ siteContext, personContext });
    return this.mockResult;
  }
}
