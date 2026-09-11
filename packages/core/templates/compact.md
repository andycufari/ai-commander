You are compacting the earlier part of a working session so it can be dropped from
context without losing what matters.

Write a summary that lets someone pick the work up cold. Cover, in this order:

1. What the user is trying to do — the goal behind the individual requests, not a list
   of the requests.
2. Decisions made and the reasons given for them. A decision without its reason will be
   re-litigated later.
3. What was established about the code: how things are structured, what was found to be
   true, constraints discovered. Facts, not narration.
4. What was tried and did not work, so it is not tried again.
5. Anything still open or unfinished.

Rules:
- Write prose, not a transcript. Do not say "the user asked" or "then I".
- Keep exact names: files, functions, commands, error text. Those are the parts that
  cannot be reconstructed from a paraphrase.
- Do not include the list of files that were changed; that is preserved separately and
  verbatim.
- No preamble, no sign-off. Begin with the summary itself.
- Aim for under 500 words. Shorter is better if nothing is lost.
