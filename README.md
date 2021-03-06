Check zib 2017 mappings to FHIR

Aspects:
* Short and Alias
* Are all zib elements mapped at least once?
* N.B. Some zibs are mapped to multiple resources
* Cardinalities
* Datatype
* TODO: Coding (DefinitionCode)
    mapping [ {
    "identity": "sct-attr",
    "uri": "http://snomed.info/sct",
    "name": "SNOMED CT Attribute Binding"
    } ]
    element.mapping [ {
        "identity": "sct-attr",
        "map": "718497002 |Inherent location|"
    } ]
* TODO: ValueSet
    element.binding { valueSetReference: { reference, display } }
* TODO: Url to zibs.nl

Inputs:
* FHIR STU3 definitions from http://hl7.org/fhir/STU3/definitions.json.zip
* ZIBS Publicatieversie 2017.max - get by MAX exporting the ZIBS EAP requested from Nictiz zib-centrum
* latest release zibs2017 https://github.com/Nictiz/Nictiz-STU3-Zib2017/releases/tag/1.3.6
* pre-elease Snapshots! https://simplifier.net/packages/nictiz.fhir.nl.stu3.zib2017-prerelease/2.0.0-beta2/snapshots/download
We need snapshot to get all the aspects!

Inputs eOverdracht beta:
* https://simplifier.net/nictizstu3-zib2017/$download?format=json&filter=Resource
* For this first generate snapshots! index-snapshot.js

Solution components:
* node.js
* https://github.com/lantanagroup/FHIR.js for validating the profile
* hl7 max and xml2js to read the max zibs2017

Setup:
```
> unzip definitions.json.zip -d definitions
> tar -zxvf nictiz.fhir.nl.stu3.zib2017-prerelease-2.0.0-beta2.tgz
> .. and put "ZIBS Publicatieversie 2017.max" in the definitions folder
> npm update
```

Run:
```
> node index.js > report.xml
```
Import the report.xml into a spreadsheet.

You can also start a node Docker container and run it there:
```
> docker run -it -v "`pwd`":/app node /bin/bash
```
