# USGS LSDS-1368 Collection 1 guide version 3.0

Source: https://d9-wret.s3.us-west-2.amazonaws.com/assets/palladium/production/s3fs-public/atoms/files/LSDS-1368_L8_C1-LandSurfaceReflectanceCode-LASRC_ProductGuide-v3.pdf
Retrieved: 2026-10-11T13:39:51.455664+00:00

PDF page 1
LSDS-1368 
Version 3.0 
 
Department of the Interior 
U.S. Geological Survey 
 
 
 
 
 
Landsat 8 Collection 1 (C1) 
Land Surface Reflectance Code (LaSRC) 
Product Guide 
 
 
 
 
 
 
 
 
 
 
 
 
Version 3.0 
 
August 2020 
 
 
 
 


PDF page 4
 - iv - LSDS-1368 
Version 3.0 
 
Document History 
Document 
Number 
Document 
Version 
Publication 
Date 
Change 
Number 
LSDS-1368 Version 1.0 December 2018 CR 14577 
LSDS-1368 Version 2.0 May 2019 CR 14853 
LSDS-1368 Version 3.0 August 2020 CR 20003 
 
 

PDF page 16
 - 10 - LSDS-1368 
Version 3.0 
 
Section 6 Product Characteristics 
Landsat Collection 1 L1 data are described on https://www.usgs.gov/land-
resources/nli/landsat/landsat-level-1-processing-details. The characteristics of C1 L2 
SR, TOA Reflectance, and TOA BT products are described in the following sections. 
6.1 SR Specifications  
L8 SR products are generated at 30-meter spatial resolution on a Universal Transverse 
Mercator (UTM) or Polar Stereographic (PS) mapping grid. The default file format is 
GeoTIFF, but options for delivery in Hierarchical Data Format – Earth Observing 
System – 2 (HDF-EOS-2; .hdf), Network Common Data Form (.NetCDF) or Exelis 
Visual Information Solutions (ENVI) binary (.img) are available through the ESPA 
Ordering Interface. More information on output formats can be found in the ESPA On 
Demand Interface User Guide.  
 
L8 SR are delivered in files named with the productID and appended with “_sr_” 
followed by a band designation. All packages include Extensible Markup Language 
(xml)-based metadata. 
 
The SR bands are delivered in separate, condition-specific files, with the exception of 
the Aerosol QA band, which is delivered in a single bit-packed layer (For more details 
on Aerosol QA band see Section 6.1.2). Table 6-1 lists the specifications for the bands 
included in a SR data file. Table 6-2 describes the bit assignments for the pixel_qa 
band. The pixel_qa bit values are given in Table 6-3, and shown in greater detail in 
Table 6-4. 
 
 
Band Designation Band Name Data 
Type Units Range Valid 
Range 
Fill 
Value 
Saturate 
Value 
Scale 
Factor 
ProductID_sr_band1 Band 1 INT16 Reflectance -2000 – 
16000 
0 - 
10000 -9999 20000 0.0001 
ProductID_sr_band2 Band 2 INT16 Reflectance -2000 – 
16000 
0 - 
10000 -9999 20000 0.0001 
ProductID_sr_band3 Band 3 INT16 Reflectance -2000 – 
16000 
0 - 
10000 -9999 20000 0.0001 
ProductID_sr_band4 Band 4 INT16 Reflectance -2000 – 
16000 
0 - 
10000 -9999 20000 0.0001 
ProductID_sr_band5 Band 5 INT16 Reflectance -2000 – 
16000 
0 - 
10000 -9999 20000 0.0001 
ProductID_sr_band6 Band 6 INT16 Reflectance -2000 – 
16000 
0 - 
10000 -9999 20000 0.0001 
ProductID_sr_band7 Band 7 INT16 Reflectance -2000 – 
16000 
0 - 
10000 -9999 20000 0.0001 
ProductID_pixel_qa Level 2 Pixel 
Quality Band UINT16 Bit Index 0-32768 0-32768 1 (bit 0) NA NA 
ProductID_sr_aerosol Aerosol QA UINT8 Bit Index 0 - 255 0 - 255 NA NA NA 
ProductID_radsat_qa Radiometric 
Saturation QA UINT16 Bit Index 0-32768 0-3839 1 (bit 0) NA NA 
ProductID_MTL.txt Level 1 
Metadata file NA NA NA NA NA NA NA 
