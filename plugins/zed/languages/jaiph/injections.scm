; Embedded script/inline-script bodies: lang''' ... ''' .
; When the fence carries an interpreter tag (`python3'''`), inject that grammar
; into the body.
(fenced_block
  language: (language) @language
  body: (embedded) @content)

; A bare fence (''' ... ''') defaults to shell, matching Jaiph's runtime.
((fenced_block
  !language
  body: (embedded) @content)
  (#set! "language" "bash"))
