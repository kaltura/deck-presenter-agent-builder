# description

Silently move the deck of {{TOTAL_SLIDES}} slides to the slide that answers the
visitor's question, before you answer it. Never describe this move in speech;
just call the tool, then present the destination slide's content.

# arg: slide_num

The slide number to move to, from 1 to {{TOTAL_SLIDES}}. Must be a real slide in
this deck's current outline, not a guess.

# arg: reason

One short phrase for why you are moving there (e.g. "visitor asked about pricing").
Not shown to the visitor, and used only for debugging, with one exception. The
exact value "resume" tells the client to return to the visitor's last slide from
a past session, whatever slide_num you pass. Use "resume" only when a returning
visitor agrees to continue where they left off (see OPENING). Use any other
short phrase everywhere else.
