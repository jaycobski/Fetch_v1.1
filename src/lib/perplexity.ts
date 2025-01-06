import { ApiClient } from './api-client';
import { StoredPost } from '@/utils/db';
import { SummaryCategory } from '@/types/summary';
import { supabase } from '@/lib/supabase';

export class PerplexityClient {
  private apiClient: ApiClient;
  private model = 'llama-3.1-sonar-large-128k-online';
  private userId: string | null = null;
  private maxRetries = 3;
  private retryDelay = 2000; // 2 seconds

  // Make categorizePost public so it can be used elsewhere
  public categorizePost(post: StoredPost): string {
    const CATEGORIES = {
      'Technology & Programming': [
        'programming', 'webdev', 'javascript', 'typescript', 'react', 'node',
        'technology', 'coding', 'developer', 'software', 'tech'
      ],
      'Investing & Crypto': [
        'bitcoin', 'cryptocurrency', 'investing', 'stocks', 'wallstreetbets',
        'finance', 'crypto', 'trading'
      ],
      'Science & Education': [
        'science', 'space', 'physics', 'biology', 'chemistry', 'education',
        'learning', 'research', 'study'
      ],
      'Entertainment & Gaming': [
        'gaming', 'games', 'pcgaming', 'nintendo', 'playstation', 'xbox',
        'entertainment', 'movies', 'television'
      ],
      'Other': []
    };

    const subreddit = post.subreddit?.toLowerCase() || '';
    const title = post.title?.toLowerCase() || '';
    const content = post.content?.toLowerCase() || '';

    for (const [category, keywords] of Object.entries(CATEGORIES)) {
      if (keywords.some(keyword => 
        subreddit.includes(keyword) || 
        title.includes(keyword) || 
        content.includes(keyword)
      )) {
        return category;
      }
    }

    return 'Other';
  }

  constructor(userId?: string) {
    const apiKey = import.meta.env.VITE_PERPLEXITY_API_KEY;
    if (!apiKey) {
      throw new Error('Perplexity API key is not configured');
    }

    this.userId = userId;
    this.apiClient = new ApiClient({
      baseUrl: import.meta.env.VITE_SUPABASE_URL + '/functions/v1/perplexity',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
    });
  }

  private async retryWithBackoff<T>(
    operation: () => Promise<T>,
    attempt = 1
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= this.maxRetries) {
        throw error;
      }
      
      await new Promise(resolve => 
        setTimeout(resolve, this.retryDelay * Math.pow(2, attempt - 1))
      );
      
      return this.retryWithBackoff(operation, attempt + 1);
    }
  }

  async generateSummary(post: StoredPost, options: {
    maxLength?: number;
    style?: 'concise' | 'detailed';
  } = {}): Promise<string | null> {
    console.log('Starting generateSummary for post:', post.id);
    
    if (!post.content && !post.title) {
      console.warn('No content to summarize for post:', post.id);
      return null;
    }

    const prompt = this.buildPrompt(post, options);
    console.log('Built prompt:', prompt);
    
    console.log('Sending content to Perplexity');

    const startTime = Date.now();
    let success = false;
    let errorMessage = null;
    let completion = null;
    let response = null;

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      console.error('User not authenticated');
      throw new Error('User not authenticated');
    }

    try {
      console.log('Making API request to Perplexity');
      response = await this.retryWithBackoff(() => this.apiClient.post('/api/chat/completions', {
        model: this.model,
        messages: [{
          role: "system",
          content: "You are an AI assistant specializing in summarizing content. Your task is to provide clear, informative summaries that capture the key points and main ideas of the content."
        }, {
          role: "user",
          content: prompt
        }],
        userId: this.userId
      }));

      console.log('Received API response:', response);
      completion = response?.choices?.[0]?.message?.content;
      if (!completion) {
        console.error('No output in API response');
        throw new Error('No output received from Perplexity API');
      }
      success = true;
    } catch (error) {
      errorMessage = error.message;
      console.error('Perplexity API error:', error);
      throw error;
    } finally {
      const duration = Date.now() - startTime;
      
      // Log completion data if we have a user ID
      if (this.userId) {
        console.log('Logging completion to database');
        const { data: completionData, error: completionError } = await supabase
          .from('summaries')
          .insert({
            user_id: this.userId,
            post_id: post.id,
            content: completion,
            category: this.categorizePost(post),
            status: success ? 'completed' : 'failed'
          })
          .select()
          .single();
        
        if (completionError) {
          console.error('Error logging completion:', completionError);
        }
      }
    }

    if (!completion) {
      console.error('No output received from Perplexity API');
      return null;
    }

    return completion;
  }

  async generateDigest(posts: StoredPost[]): Promise<SummaryCategory[]> {
    // Group posts by subreddit for batch processing
    const groupedPosts = posts.reduce((acc, post) => {
      const category = this.categorizePost(post);
      if (!acc[category]) {
        acc[category] = [];
      }
      acc[category].push(post);
      return acc;
    }, {} as Record<string, StoredPost[]>);

    // Generate summaries for each category
    const categories = await Promise.all(
      Object.entries(groupedPosts).map(async ([category, posts]) => {
        const summaries = await Promise.all(
          posts.map(post => this.generateSummary(post))
        );

        return {
          name: category,
          posts: posts.map((post, i) => ({
            title: post.title || '',
            summary: summaries[i],
            source: `r/${post.subreddit}`,
            url: post.url
          }))
        };
      })
    );

    return categories;
  }

  private buildPrompt(post: StoredPost, options: {
    maxLength?: number;
    style?: 'concise' | 'detailed';
  }): string {
    const maxLength = options.maxLength || 200;
    const style = options.style || 'concise';
    const content = post.content || post.title;

    return `
      Please provide a clear and informative summary of the following content:

      Title: ${post.title}
      Content: ${content}
      Source: Reddit - r/${post.subreddit}
      
      Guidelines:
      - Aim for a ${maxLength}-word ${style} summary
      - Focus on key points and main ideas
      - Maintain original context and meaning
      - Use clear, concise language
      
      Please provide the summary in a single paragraph.
    `.trim();
  }

}