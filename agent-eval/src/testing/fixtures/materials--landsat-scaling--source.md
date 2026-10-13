# USGS Landsat Level-2 scaling and fill values

Source: https://www.usgs.gov/faqs/how-do-i-use-a-scale-factor-landsat-level-2-science-products
Frozen retrieval: 2026-10-11T13:21:57.165442+00:00
Selected source text; gaps between excerpts are marked. This file is not a live webpage.

Scale factors, fill values, data type, and valid range for Landsat Collection 1 and Collection 2 science products Science Product Scale Factor Additive Offset Fill Value Data Type Valid Range Collection 2 Surface Reflectance 0.0000275 -0.2 0 Unsigned 16-bit integer 7273-43636 Surface Temperature 0.00341802 149 0 Unsigned 16-bit integer 293 - 65535 Provisional Aquatic Reflectance 0.00001 (RHORC layers = 0.0001) N/A -9999 Signed 16-bit integer 0-10000 Collection 1 (historic) Collection 1 information is available here for reference only Surface Reflectance 0.0001 N/A -9999 Signed 16-bit integer 0-10000 Provisional Surface Temperature 0.1 N/A -9999 Signed 16-bit integer 0-10000 Examples for scaling Landsat Collection 2 Level-2 science products

---

Landsat Collection 2 surface reflectance has a scale factor of 0.0000275 and an additional offset of -0.2 per pixel. For example , a pixel value of 18,639 is multiplied by 0.0000275 for the scale factor and then -0.2 is added for the additional offset to get a reflectance value of 0.313 after the scale factor is applied.
