import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const PERPLEXITY_API_URL = 'https://api.perplexity.ai/api/chat/completions'

serve(async (req) => {
  // Add CORS headers
  const headers = new Headers({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Content-Type': 'application/json',
  })

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers })
  }

  try {
    const { messages, model } = await req.json()

    // Forward request to Perplexity
    const response = await fetch(PERPLEXITY_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${Deno.env.get('PERPLEXITY_API_KEY')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messages, model }),
    })

    if (!response.ok) {
      throw new Error(`Perplexity API error: ${response.status}`)
    }

    const data = await response.json()
    return new Response(JSON.stringify(data), { headers })
  } catch (error) {
    console.error('Edge function error:', error)
    return new Response(
      JSON.stringify({ error: error.message }), 
      { status: 500, headers }
    )
  }
})