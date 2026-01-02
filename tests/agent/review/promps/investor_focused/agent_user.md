Investment thesis:

<<< INVESTMENT THESIS START >>>

{{InvestorThesis}}

<<< INVESTMENT THESIS END >>>

Stage of round (if known, otherwise infer from the deck):
Pre-seed / Seed / Series A / Series B+

Pitch deck content:

<<< INVESTMENT DECK START >>>

{{InvestmentDeck}}

<<< INVESTMENT DECK END >>>

Return a JSON object with exactly the following fields:

{
"stage_match": true | false,
"notes": "one short sentence about stage fit (ONLY stage; NOT sector/thesis fit)",
"relevancy": "low | medium | high",
"relevancy_reason": "why you chose that relevancy",
"strengths": ["...", "...", "..."],
"weaknesses": ["...", "...", "..."],
"key_open_questions": ["...", "...", "..."],
"summary_markdown": "short markdown summary of thesis alignment",
"founder_note": "short, professional note written from the VC to the founder; questions framed as general considerations, not requests"
}