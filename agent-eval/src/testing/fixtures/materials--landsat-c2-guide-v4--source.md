# USGS LSDS-1619 Collection 2 guide version 4.0

Source: https://d9-wret.s3.us-west-2.amazonaws.com/assets/palladium/production/s3fs-public/media/files/LSDS-1619_Landsat-8-9-C2-L2-ScienceProductGuide-v4.pdf
Retrieved: 2026-10-11T13:40:00.669544+00:00

PDF page 1
LSDS-1619 
Version 4.0 
 
Department of the Interior 
U.S. Geological Survey 
 
 
 
 
 
Landsat 8-9  
Collection 2 (C2) 
Level 2 Science Product (L2SP) Guide 
 
 
 
 
 
 
 
 
 
 
 
 
Version 4.0 
 
March 2022 
 
 
 
 


PDF page 4
 - iv - LSDS-1619 
Version 4.0 
Document History 
Document 
Number 
Document 
Version 
Publication 
Date 
Change 
Number 
LSDS-1619 Version 1.0 May 2020 CR 15400 
LSDS-1619 Version 2.0 September 2020 CR 20016 
LSDS-1619 Version 3.0 September 2021 CR 20746 
LSDS-1619 Version 4.0 March 2022 CR 20976 
 
 

PDF page 18
 - 12 - LSDS-1619 
Version 4.0 
 
Band Designation Band Name Data Type Units 
Data 
Range Valid Range 
Fill 
Value 
Multiplicative 
Scale Factor Additive Offset 
ProductID_SR_B1 Band 1 SR UINT16 Reflectance 1 - 65535 7273 - 43636 0 0.0000275 -0.2 
ProductID_SR_B2 Band 2 SR UINT16 Reflectance 1 - 65535 7273 – 43636 0 0.0000275 -0.2 
ProductID_SR_B3 Band 3 SR UINT16 Reflectance 1 - 65535  7273 - 43636 0 0.0000275 -0.2 
ProductID_SR_B4 Band 4 SR UINT16 Reflectance 1 - 65535  7273 - 43636 0 0.0000275 -0.2 
ProductID_SR_B5 Band 5 SR UINT16 Reflectance 1 - 65535  7273 - 43636 0 0.0000275 -0.2 
ProductID_SR_B6 Band 6 SR UINT16 Reflectance 1 - 65535 7273 - 43636 0 0.0000275 -0.2 
ProductID_SR_B7 Band 7 SR UINT16 Reflectance 1 - 65535  7273 - 43636 0 0.0000275 -0.2 
ProductID_ST_B10 Band 10 ST UINT16 Kelvin 1 - 65535 293 - 61440 0 0.00341802 149 
ProductID_QA_PIXEL Level 2 Pixel 
Quality Band UINT16 Bit Index 1 - 65535 21824 – 65534 1 NA NA 
ProductID_SR_QA_AEROSOL Aerosol QA UINT8 Bit Index 0 - 255 1 - 255 1 NA NA 
ProductID_QA_RADSAT Radiometric 
Saturation QA UINT16 Bit Index 0 - 65535 0 - 3829 NA NA NA 
ProductID_ST_QA 
Surface 
Temperature 
Uncertainty 
INT16 Kelvin 0 - 32767 0 - 32767 -9999 0.01 NA 
ProductID_ST_TRAD Thermal  
Radiance INT16 W/(m2.sr.μm)/
DN  0 - 22000 0 – 22000 -9999 0.001 NA 
ProductID_ST_URAD Upwelled 
Radiance INT16 W/(m2.sr.μm)/
DN  0 - 28000 0 – 28000 -9999 0.001 NA 
ProductID_ST_DRAD Downwelled 
Radiance INT16 W/(m2.sr.μm)/
DN  0 - 28000 0 - 28000 -9999 0.001 NA 
ProductID_ST_ATRAN Atmospheric 
Transmittance INT16 Unitless 0 - 10000 0 - 10000 -9999 0.0001 NA 
ProductID_ST_EMIS 
Emissivity 
estimated from 
ASTER GED 
INT16 Unitless 0 - 10000 0 - 10000 -9999 0.0001 NA 
ProductID_ST_EMSD 
Emissivity 
standard 
deviation 
INT16 Unitless 0 - 32767 0 – 10000 -9999 0.0001 NA 
ProductID_ST_CDIST Pixel distance to 
cloud INT16 Kilometers 0 - 24000 0 – 24000 -9999 0.01 NA 
ProductID_MTL Level 2 Metadata 
file NA NA NA NA NA NA NA 
Table 6-1. Collection 2 (C2) Landsat 8-9 Level 2 Science Products (L2SP) Band Specifications
