// ai-usage passes report values through sys.inputs.data.
#let data = json(bytes(sys.inputs.data))
#set document(title: data.supplier + " " + data.subtitle)
#set page(paper: "a4", margin: (x: 1.5cm, y: 1.6cm))
#set text(font: "Inter", size: 8.5pt, fill: black)
#set par(leading: 0.65em, spacing: 0.8em)
#set heading(numbering: none)
#show heading: set text(size: 13.5pt, weight: "semibold")
#show heading: set block(above: 18pt, below: 12pt)

#let usage-table(labels, rows, total, columns: auto, text-columns: 1, size: 7.5pt) = {
  set text(size: size)
  show table.cell.where(y: rows.len() + 1): set text(weight: "semibold")
  table(
    columns: columns,
    align: (x, y) => if x < text-columns { left } else { right },
    inset: (x: 3pt, y: 4pt),
    stroke: none,
    table.header(
      table.hline(stroke: 1.2pt),
      ..labels.map(label => strong(label)),
      table.hline(stroke: 0.5pt),
    ),
    ..rows.flatten(),
    table.footer(
      repeat: false,
      table.hline(stroke: 1.2pt),
      ..total,
    ),
  )
}

#let token-cells(row) = (row.input, row.output, row.cache_write, row.cache_read, row.tokens)

#grid(
  columns: (1fr, auto),
  column-gutter: 12pt,
  [
    #text(size: 20pt, weight: "semibold", data.supplier)
    #v(4pt)
    #data.subtitle
    #if data.account != "" [
      #v(4pt)
      Account: #data.account
    ]
  ],
  align(right)[
    #data.generated_at \
    #data.first_day – #data.last_day
  ],
)

= Tokens by Model

#usage-table(
  ("Model", "Input", "Output", "Cache write", "Cache read", "Total"),
  data.models.map(row => (row.model, ..token-cells(row))),
  ("TOTAL", ..token-cells(data.totals)),
  columns: (1.5fr, 1fr, 1fr, 1fr, 1fr, 1fr),
)

= Daily Tokens

#usage-table(
  ("Date", "Model", "Input", "Output", "Cache write", "Cache read", "Total"),
  data.daily.map(row => (row.day, row.model, ..token-cells(row))),
  ("TOTAL", "", ..token-cells(data.totals)),
  columns: (auto, 1fr, auto, auto, auto, auto, auto),
  text-columns: 2,
  size: 7pt,
)

#block(breakable: false)[
  = About These Figures

  This document reports token usage for #data.supplier models used through
  #data.assistants, aggregated by day and across model.

  Tokens are small pieces of text that models read and write. Input tokens are
  sent to the model; output tokens are produced by it. Cache tokens are stored
  or reused during a session.
]
