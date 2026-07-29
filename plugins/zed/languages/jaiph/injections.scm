; Embedded script/inline-script bodies: ```lang ... ``` .
; When the fence carries a language tag, inject that grammar into the body.
(fenced_block
  (language) @language
  (embedded) @content)

; A bare fence (```  ... ```) defaults to shell, matching Jaiph's runtime.
((fenced_block (embedded) @content)
  (#set! "language" "bash"))
