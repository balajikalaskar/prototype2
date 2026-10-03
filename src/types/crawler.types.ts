export interface ExtractionLimits {
  maxTextLength: number;
  maxLinks: number;
  maxHeadings: number;
}

export interface PageContent {
  title: string | null;
  description: string | null;
  language: string | null;
  headings: Array<{ level: number; text: string }>;
  text: string;
  links: Array<{ text: string; url: string }>;
  textTruncated: boolean;
  linksTruncated: boolean;
  headingsTruncated: boolean;
}

export interface CrawlResult extends Omit<PageContent, 'textTruncated' | 'linksTruncated' | 'headingsTruncated'> {
  url: string;
  finalUrl: string;
  httpStatus: number;
  meta: {
    durationMs: number;
    fetchedAt: string;
    textTruncated: boolean;
    linksTruncated: boolean;
    headingsTruncated: boolean;
  };
}
