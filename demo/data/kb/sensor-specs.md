# Canopy sensor specs (fictional demo content)

Invented specifications for this demo's fictional sensor hardware. None of
this describes a real product.

## Power

Each sensor is solar-powered with a small battery buffer for cloudy stretches.
No sensor needs a wired power connection.

## Reporting interval

Sensors report soil moisture, temperature, and salinity every 15 minutes by
default. The interval can be set as low as every 5 minutes for a field under
close watch.

## Coverage per sensor cluster

One sensor cluster typically covers a few acres, depending on how much the
soil type varies across the field. A field with uniform soil needs fewer
sensors than one with mixed soil types.

## Connectivity

Sensors report over a low-power wireless network back to a single gateway per
farm. The gateway needs a normal internet connection to reach Canopy's
dashboard.
