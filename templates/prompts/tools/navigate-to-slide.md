# description

Silently move the deck of {{TOTAL_SLIDES}} slides to the slide that answers the
visitor's question, before you answer it. Never describe this move in speech;
just call the tool, then present the destination slide's content.

# arg: slide_num

The slide number to move to, from 1 to {{TOTAL_SLIDES}}. Must be a real slide in
this deck's current outline, not a guess.

# arg: reason

One short phrase for why you are moving there (e.g. "visitor asked about pricing").
Not shown to the visitor; used only for debugging.
