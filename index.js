var Fhir = require('fhir').Fhir;
var ParseConformance = require('fhir').ParseConformance;
var FhirVersions = require('fhir').Versions;
var fs = require('fs');
var xml2js = require('xml2js');
const yaml = require('js-yaml');
const yargs = require('yargs');

// Unique identification string for when mappings are implicit, as described in the profiling guidelines.
const IMPLICIT_IDENTIFIER    = ' (implicit, main mapping is on '
const REVERSE_REF_IDENTIFIER = 'Reversed reference for '

// Parse command line options and argumens
const argv = yargs
    .option('max-file', {
        alias: 'm',
        description: 'Path to .max file',
        type: 'string',
        demandOption: true
    })
    .option('zib-release', {
        alias: 'z',
        description: 'The zib release to check mappings for',
        type: 'string',
        choices: ['2017', '2020'],
        demandOption: true
    })
    .option('fhir-version', {
        alias: 'v',
        description: 'The FHIR version to use (the "fhirVersion" element in the structuredefinitions will be ignored).\nIf the version is STU3, the definitions should be present in the "definitions" folder.',
        type: 'string',
        choices: ['STU3', 'R4'],
        default: 'R4'
    })
    .option('check-missing', {
        description: 'Check for missing elements from all zibs ("all"), the zibs that are mapped to the checked profiles ("mapped-only") or none at all ("none").',
        type: 'string',
        choices: ['none', 'mapped-only', 'all'],
        default: 'none'
    })
    .option('fail-at', {
        alias: 'a',
        description: 'The level at which issues are considered fatal (error or warning).',
        type: 'string',
        choices: ['error', 'warning'],
        default: 'error'
    }).option('zib-overrides', {
        description: 'One or more YAML files specifying zib concepts that are purposefully not mapped faithfully to the profiles. This file should look like:\n\n>  [resource id]:\n>    zib deviations:\n>      [element id]:\n>        - [deviation]: [value]\n>          reason: [Explanation for deviation]\n>  unmapped zib concepts:\n>    - [zib concept id]: [zib concept name]\n>      reason: [Explanation for not mapping]\n\nWhere [deviation] can be "cardinality", "datatype", "short" or "alias". For each element, multiple deviations may be specified. Note that for each deviation, a reason *must* be provided.',
        type: 'array'
    }).option('output-format', {
        alias: 'f',
        description: 'Set the output format to either text or XML.\nIn both cases, the output will be printed to stdout.\nWhen the output is XML, a complete record of all found elements is created, while additional problems are printed to stderr.\nWhen the output format is text, only the issues found are printed.',
        default: 'xml',
        type: 'string',
        choices: ['xml', 'text']
    }).option('stats-file', {
        description: 'Write statistics to the following JSON file.',
        type: 'string',
    })
    .command("$0 [options] <files..>", "")
    .help().alias('help', 'h')
    .argv;

// Instantiate the FHIR parser
if (argv["fhir-version"] == "STU3") {
    // Fhir versions other than R4 need to manually load the definitions
    var newValueSets = JSON.parse(fs.readFileSync('definitions/valuesets.json').toString());
    var newTypes = JSON.parse(fs.readFileSync('definitions/profiles-types.json').toString());
    var newResources = JSON.parse(fs.readFileSync('definitions/profiles-resources.json').toString());
    var parser = new ParseConformance(false, FhirVersions.STU3);
    parser.parseBundle(newValueSets);
    parser.parseBundle(newTypes);
    parser.parseBundle(newResources);
    var fhir = new Fhir(parser);
} else {
    var fhir = new Fhir();
}

// read and parse zibs from max xml source to json
var xmlParser = new xml2js.Parser();
var max = fs.readFileSync(argv["max-file"]);
var zibs = {};
xmlParser.parseString(max, function (err, result) {
    zibs = result;
});

// relationship with sourceId = id, targetId = datatypeid, type=Generalization
var datatypes = {
    7887: "TS",
    7906: "CD",
    7895: "ST",
    7891: "PQ",
    7892: "BL",
    7888: "INT",
    7886: "CO",
    7885: "ED",
    7889: "II",
    7903: "ANY"
};

/** 
 * The graveness that a detected issue may have.
 */
let IssueLevel = {
    "OK":      "ok",
    "WARNING": "warning",
    "ERROR":   "error"
}

/**
 * Class to hande output to the terminal.
 */
class Output {
    constructor() {
        // Output consists of a set of lines, where each line is stored as [message, boolean indicating if this is an
        // error or not].
        this.lines = []
    }

    /**
     * Add a normal line to the output
     * @param {string} line 
     */
    addLine(line) {
        this.lines.push([line, false])
    }

    /**
     * Add an error line to the output
     * @param {string} message 
     */
    addError(message) {
        this.lines.push([message, true])
    }

    /**
     * Add the content of another output object to this object.
     * @param {Output} output 
     */
    addOutput(output) {
        this.lines = this.lines.concat(output.lines)
    }

    /**
     * Indicate if this object contains normal lines.
     * @returns true if this Output object contains normal lines.
     */
    hasLines() {
        return (this.lines.filter(line => line[1] == false).length > 0)
    }

    /**
     * 
     * @param {boolean} error_to_stderr - Indicate whether errors should be sent to stderr. If not, they are written to
     *                                    stdout.
     */
    write(error_to_stderr = false) {
        this.lines.forEach(line => {
            if (error_to_stderr && line[1]) {
                console.error(line[0])
            } else {
                console.log(line[0])
            }
        })
    }
}

/**
 * Overall report for the test run, containing reports per profile and detected issues.
 */
class Report {
    constructor() {
        this.reports = []
    }

    /**
     * Add a ProfileReport to the overall report
     * @param {ProfileReport} report
     */
    addProfileReport(report) {
        this.reports.push(report)
    }

    /**
     * Add a detected issue to the overall report
     * @param {string} message 
     * @param {IssueLevel} level - the issue level
     */
    addIssue(message, level) {
        this.reports.push(new Issue(message, level))
    }

    /**
     * Write out the report. If the format is text, everything will be written to stdout. If the format is xml, the
     * xml content will be written to stdout and detected issues to stderr.
     * @param {string} format - either "text" or "xml"
     */
    write(format) {
        this.reports.forEach(report => {
            report.format(format).write((format == "xml") ? true : false)
        })
    }

    /**
     * Return statistics about the number of issues detected.
     * @returns {Object} - Object containing the IssueLevel levels ("ok", "warning" and "error") with the total 
     *                     succesfull checks, detected warnings and detected errors respectively.
     */
    getStatistics() {
        return this.reports.reduce(Report.statsReducer, {
            "ok": 0,
            "warning": 0,
            "error": 0
        })
    }

    /**
     * Helper method to calculate statistics about the detected issue.
     * @param {Object} curr - Object containing the IssueLevel levels ("ok", "warning" and "error")
     * @param {*} addition - A class instance that the additional statistics should be taken from, using the
     *                       getStatistics() method.
     * @returns - A new Object with the summed number of "ok", "warning" and "error" messages.
     */
    static statsReducer(curr, addition) {
        if ("getStatistics" in addition) {
            let additionalStats = addition.getStatistics()
            if (IssueLevel.OK in additionalStats) {
                curr.ok += additionalStats.ok
            }
            if (IssueLevel.WARNING in additionalStats) {
                curr.warning += additionalStats.warning
            }
            if (IssueLevel.ERROR in additionalStats) {
                curr.error += additionalStats.error
            }
        }
        return curr
    }
}

/**
 * A zib compliance report per checked profile, containing reports per element and detected issues.
 */
class ProfileReport {
    constructor(filename, resourceId) {
        this.filename   = filename
        this.resourceId = resourceId
        this.reports = []
    }

    /**
     * Add an ElementReport instance to the profile report.
     * @param {ElementReport} report 
     */
    addElementReport(report) {
        this.reports.push(report)
    }

    /**
     * Add a detected issue to the profile report
     * @param {string} message 
     * @param {IssueLevel} level - the issue level
     */
    addIssue(message, level) {
        this.reports.push(new Issue(message, level))
    }

    /**
     * Return statistics about the number of issues detected.
     * @returns {Object} - Object containing the IssueLevel levels "ok", "warning" and "error" with the total
     *                     succesfull checks, detected warnings and detected errors respectively.
     */
    getStatistics() {
        return this.reports.reduce(Report.statsReducer, {
            "ok": 0,
            "warning": 0,
            "error": 0
        })
    }

    /**
     * Format the report in the requested format.
     * @param {string} format - Either "xml" or "text"
     * @returns {Output}
     */
    format(format) {
        if (format == "xml") {
            return this._formatXML()
        } else {
            return this._formatText()
        }
    }

    /**
     * Format the report as XML.
     * @returns {Output}
     */
    _formatXML() {
        let output = new Output()
        output.addLine(`<structuredefinition name="${this.filename}">`)

        this.reports.forEach(report => {
            if (report instanceof ElementReport) {
                report.conceptReports.forEach(conceptReport => {
                    output.addLine("<line>")
                    output.addLine("<zib_concept_id>" + report.conceptId + "</zib_concept_id>")
                    output.addLine("<fhir_path>" + report.fhirPath + "</fhir_path>")
                    output.addOutput(conceptReport.format("xml"))
                    output.addLine("<fhir_filename>" + this.filename + "</fhir_filename>")
                    output.addLine("<fhir_id>" + this.resourceId + "</fhir_id>")
                    output.addLine("</line>")
                })
            } else if (report instanceof Issue) {
                output.addOutput(report.format("xml"))
            }
        })
    
        output.addLine("</structuredefinition>")
        return output
    }

    /**
     * Format the report as plain text.
     * @returns {Output}
     */
    _formatText() {
        let output = new Output()

        output.addLine(`==== ${this.filename}`)
        this.reports.forEach(report => {
            if (report instanceof ElementReport) {
                let outputForElement = report.format("text")
                if (outputForElement.hasLines()) {
                    output.addLine(`     == ${report.conceptId} (${report.fhirPath})`)
                    output.addOutput(outputForElement)
                }
            } else if (report instanceof Issue) {
                output.addOutput(report.format("text"))
            }
        })

        return output
    }
}

/**
 * Report about a single FHIR element containing the various concepts for which conformance is checked.
 */
class ElementReport {
    constructor(conceptId, fhirPath) {
        this.conceptId      = conceptId
        this.fhirPath       = fhirPath
        this.conceptReports = []
    }

    /**
     * Add a report about a checked concept
     * @param {string} type - Either "short", "alias", "datatype" or "cardinality"
     * @param {string} expected - The expected value
     * @param {string} actual - The found value
     * @param {IssueLevel} level - The issue level
     */
    addConceptReport(type, expected, actual, level) {
        this.conceptReports.push(new ConceptReport(type, expected, actual, level))
    }

    /**
     * Return statistics about the number of issues detected.
     * @returns {Object} - Object containing the IssueLevel keys "ok", "warning" and "error" with the total succesfull
     *                     checks, detected warnings and detected errors respectively.
     */
    getStatistics() {
        return this.conceptReports.reduce(Report.statsReducer, {
            "ok": 0,
            "warning": 0,
            "error": 0
        })
    }

    /**
     * Format the report.
     * @param {string} format - Either "text" or "xml"
     * @returns {Output}
     */
    format(format) {
        let output = new Output()
        this.conceptReports.forEach(report => {
            output.addOutput(report.format(format))
        })
        return output
    }
}

/**
 * Abstract class for capturing issues with a specified graveness level.
 */
class AbstractIssue {
    constructor(level) {
        this.level = level
    }

    /**
     * Return statistics about the number of issues detected.
     * @returns {Object} - Object containing the IssueLevel levels "ok", "warning" and "error" with the total 
     *                     succesfull checks, detected warnings and detected errors respectively.
     */
    getStatistics() {
        if (this.level == IssueLevel.OK) {
            return {"ok": 1}
        } else if (this.level == IssueLevel.WARNING) {
            return {"warning": 1}
        } else if (this.level == IssueLevel.ERROR) {
            return {"error": 1}
        }
        return {}
    }

    get formattedLevel() {
        return this.level.toUpperCase()
    }
}

/**
 * A detected issue.
 */
class Issue extends AbstractIssue {
    /**
     * Create a new detected issue
     * @param {string} message - The issue message.
     * @param {IssueLevel} level - The level of the issue
     */
    constructor(message, level) {
        super(level)
        this.message = message
    }

    /**
     * Format the issue.
     * @param {string} format - Either "text" or "xml"
     * @returns {Output}
     */
    format(format) {
        let output = new Output()
        output.addError(`${this.formattedLevel}: ${this.message}`)
        return output
    }
}

/**
 * A report about a specific concept for which compliance was checked.
 */
class ConceptReport extends AbstractIssue {
    /**
     * 
     * @param {string} type - Either "short", "alias", "datatype" or "cardinality"
     * @param {string} expected - The expected value
     * @param {string} actual - The found value
     * @param {IssueLevel} level - The warning level
     */
    constructor(type, expected, actual, level) {
        super(level)
        this.type     = type
        this.expected = expected
        this.actual   = actual
    }

    /**
     * Format the report.
     * @param {string} format - Either "text" or "xml"
     * @returns {Output}
     */
    format(format) {
        if (format == "xml") {
            return this._formatXML()
        } else if (format == "text") {
            return this._formatText()
        }
    }

    _formatXML() {
        let output = new Output()
        if (this.type == "short") {
            output.addLine("<zib_alias_en>" + this.expected + "</zib_alias_en>")
            output.addLine("<fhir_short>" + this.actual + "</fhir_short>")
            output.addLine("<fhir_short_warn>" + this.formattedLevel + "</fhir_short_warn>")
        } else if (this.type == "alias") {
            output.addLine("<zib_name>" + this.expected + "</zib_name>")
            output.addLine("<fhir_alias>" + this.actual + "</fhir_alias>")
            output.addLine("<fhir_alias_warn>" + this.formattedLevel + "</fhir_alias_warn>")
        } else if (this.type == "datatype") {
            output.addLine("<zib_datatype>" + this.expected + "</zib_datatype>")
            output.addLine("<fhir_datatype>" + this.actual + "</fhir_datatype>")
            output.addLine("<fhir_datatype_error>" + this.formattedLevel + "</fhir_datatype_error>")
        } else if (this.type == "cardinality") {
            output.addLine("<zib_card>" + this.expected + "</zib_card>")
            output.addLine("<fhir_card>" + this.actual + "</fhir_card>")
            output.addLine("<fhir_card_warn>" + this.formattedLevel + "</fhir_card_warn>")
        }

        return output
    }

    _formatText() {
        let output = new Output()
        if (this.level != IssueLevel.OK) {
            output.addLine("        " + (this.type + ":").padEnd(13) + this.formattedLevel + ` (${this.actual} instead of ${this.expected})`)
        }
        return output
    }
}

// create zib concept indexes
// only add objects that have a DCM::ConceptId
var _packageByConceptId = []; // package id by conceptid
var _conceptsById = []; // object by conceptid
zibs.model.objects[0].object.forEach(object => {
    if (object.parentId && object.tag) {
        var tag = object.tag.find(tag => tag.$.name === 'DCM::ConceptId');
        if (!tag) {
            // this is possibly an "old" zib with conceptid in definitioncode
            tag = object.tag.find(tag => tag.$.name === 'DCM::DefinitionCode' && tag.$.value.startsWith("NL-CM:"));
        }
        if (tag) {
            var zibId = tag.$.value;
            _packageByConceptId[zibId] = object.parentId;
            _conceptsById[zibId] = object;

            // relationship type = Generalization ; sourceId = zibId map destId
            var relDt = zibs.model.relationships[0].relationship.find(relationship => relationship.type[0] === "Generalization" && relationship.sourceId[0] == object.id);
            if (relDt) {
                object.datatype = datatypes[relDt.destId];
            }

            // relationship typ = Aggregation ; sourfeId = zibId sourceCard
            var relCard = zibs.model.relationships[0].relationship.find(relationship => relationship.type[0] === "Aggregation" && relationship.sourceId[0] == object.id);
            if (!relCard || relCard.sourceCard == '') {
                // when no cardinality specified default
                object.cardinality = "0..1";
            }
            else if (relCard) {
                var card = relCard.sourceCard[0];
                if (card == "1") card = "1..1";
                
                // Zibs define a "conceptual" cardinality, meaning that they define the concepts that are conceptually
                // present, although in practice they may be absent in practical use cases. To facilitate this, the
                // FHIR min cardinality for zib profiles must always be zero. See 
                // https://zibs.nl/wiki/Zib_kardinaliteiten for more information. 
                let minAndMax = card.split("..");
                object.cardinality = `0..${minAndMax[1]}`;            }
        }
    }
});

/**
 * Class to handle purposeful deviations from the zib values in profiles, described in a YAML file. See the help for a
 * description of the file format.
 */
class ZibOverrides {
    /**
     * @param {string|null} path - path to the YAML file. May be empty, in which case this class won't do much.
     */
    constructor(path = null) {
        this.overrides = null
        this.load(path)
    }

    load(path = null) {
        if (path == null) return
        if (this.overrides == null) {
            this.overrides = {}
        }
        let overrides = yaml.safeLoad(fs.readFileSync(path, 'utf8'))
        let require_occurence = true
        if ("issues should occur" in ignored_issues) {
            require_occurence = (ignored_issues["issues should occur"] == true)
            delete ignored_issues["issues should occur"]
        }
        Object.keys(overrides).forEach(resource_id => {
            if ("zib deviations" in overrides[resource_id]) {
                let resource_regex = "^" + resource_id.replace(".", "\\.").replace("*", ".*?") + "$"
                let issues_for_resource = (resource_regex in this.overrides) ? this.overrides[resource_regex] : {}
                Object.keys(overrides[resource_id]["zib deviations"]).forEach(path_id => {
                    let path_regex = "^" + path_id.replace(".", "\\.").replace("*", ".*?").replace("[", "\\[").replace("]", "\\]") + "$"
                    let issues_for_path = (path_regex in issues_for_resource) ? issues_for_resource[path_regex] : []
                    overrides[resource_id]["zib deviations"][path_id].forEach(issue => {
                        issue["handled"]          = false
                        issue["require_presence"] = require_occurence
                        issues_for_path.push(issue)
                    })
                    issues_for_resource[path_regex] = issues_for_path
                })
                this.overrides[resource_regex] = issues_for_resource
            }
        })
    }

    /**
     * Check if there's a deviation from the zib for the concept of the given element in the given resource.
     * 
     * @param {string} resourceId - the resource.id of the current resource
     * @param {string} elementId - the id of the element
     * @param {string} key - either cardinality, datatype, alias or 
     * @returns {null|string} - the overridden value, if found.
     */
    check(resourceId, elementId, key) {
        if (this.overrides == null) return null

        let overridden = new Set();
        Object.keys(this.overrides).forEach(resourceRegex => {
            if (resourceId.match(new RegExp(resourceRegex, "m"))) {
                Object.keys(this.overrides[resourceRegex]).forEach(pathRegex => {
                    if (elementId.match(new RegExp(pathRegex, "m"))) {
                        this.overrides[resourceRegex][pathRegex].filter(knownIssue => key in knownIssue).forEach(knownIssue => {
                            if (!("reason" in knownIssue)) {
                                console.error(`Missing reason for overriding '${key}' in ${resourceId} (${elementId})`)
                                process.exit(1);
                            }
                            knownIssue["handled"] = true
                            overridden.add(knownIssue[key])
                        })
                    }
                })
            }
        })

        if (overridden.size > 1) {
            console.error(`Conflicting zib deviations were defined for '${key}' in ${resourceId} (${elementId})`)
            process.exit(1);
        } else if (overridden.size == 1) {
            console.log(overridden.keys().next().value)
            return overridden.keys().next().value
        }
        return null
    }

    /**
     * Check if the zib concept id is registered under "unmapped zib concepts".
     * 
     * @param {string} zibId - the zib concept id to check.
     * @returns {boolean}
     */
    hasUnmapped(zibId) {
        if (this.overrides == null) return null

        let is_unmapped = false;
        if ("unmapped zib concepts" in this.overrides) {
            this.overrides["unmapped zib concepts"].forEach(unmapped => {
                if (zibId in unmapped) {
                    if (!("reason" in unmapped)) {
                        console.error(`Missing reason for unmapped '${zibId}'`)
                        process.exit(1);
                    }
                    is_unmapped = true;
                }
            })
        }
        return is_unmapped;
    }
}
var zibOverrides = new ZibOverrides()
argv["zib-overrides"].forEach(overridesFile => zibOverrides.load(overridesFile))

// Collect als zib ids that are mapped in the supplied StructureDefinitions
let zibIdsMapped = new Set()

// The identifier to recognize mappings for the target zib release
let zibRegEx = new RegExp("-" + argv["zib-release"] + "EN");

let report = new Report()

argv.files.forEach(filename => {
    var json = fs.readFileSync(filename);

    // zib compliance check only for StructureDefinitions
    var resource = JSON.parse(json);
    var validated = false;
    if (resource.resourceType == "StructureDefinition") {
        if (resource.mapping) {
            let profileReport = new ProfileReport(filename, resource.id)

            // does this resource have mappings to the target zib release?
            let hasZibReleaseMappings = resource.mapping.find(mapping => zibRegEx.test(mapping.identity));
            if (hasZibReleaseMappings) {
                if (!validated) {
                    // validate fhir structuredef only if there are any zib mappings
                    var result = fhir.validate(resource);
                    if (result.messages.length > 0) {
                        // Sometimes the validator complains that the FHIR version is unknown. if that's the case, we
                        // remove the offending message first.
                        if (result.messages[0].location == "StructureDefinition.fhirVersion" &&
                            result.messages[0].message.match(/Code \"[0-9\.]+\" not found in value set/)) {
                                result.messages = result.messages.slice(1);
                        }
                    }
                    if (result.messages.length > 0) {
                        let msg = `validating resource ${filename}\n` + JSON.stringify(result.messages, null, 4)
                        if (result.valid) {
                            report.addIssue(msg, IssueLevel.WARNING)
                        } else {
                            report.addIssue(msg, IssueLevel.ERROR)
                        }
                    }
                }
                validated = true;
               
                // check elements in snapshot for mappings
                if (resource.snapshot) {
                    resource.snapshot.element.forEach(element => {
                        if (element.mapping) {
                            // check mappings and only handle mappings to the target zib release
                            element.mapping.forEach(mapping => {
                                if (zibRegEx.test(mapping.identity) && !mapping.comment.includes(IMPLICIT_IDENTIFIER)) {
                                    zibIdsMapped.add(mapping.map)

                                    let elementReport = new ElementReport(mapping.map, element.id)

                                    let fhirShort = element.short.toString()
                                    let fhirAlias = element.alias ? element.alias.toString() : ''

                                    let conceptNameEN = zibOverrides.check(resource.id, element.id, "short")
                                    let conceptNameNL = zibOverrides.check(resource.id, element.id, "alias")

                                    let concept = _conceptsById[mapping.map];
                                    if (!concept) {
                                        profileReport.addIssue(`unknown concept ${mapping.map}`, IssueLevel.ERROR)
                                        return;
                                    }

                                    if (mapping.comment.startsWith(REVERSE_REF_IDENTIFIER)) {
                                        // If the mapping documents a reference that in FHIR points in the opposite
                                        // direction of what the zib specifies, short and alias should be set to the
                                        // target of the reference.
                                        let rootconcept = _conceptsById[getCMPrefix(mapping.map) + ".1"]
                                        if (conceptNameEN == null) {
                                            conceptNameEN = rootconcept.alias[0].substring(3).trim()
                                        }
                                        if (conceptNameNL == null) {
                                            conceptNameNL = rootconcept.name[0]
                                        }
                                    } else {
                                        if (conceptNameEN == null) {
                                            let conceptNames = [];
                                            element.mapping.forEach(mapping => {
                                                if (zibRegEx.test(mapping.identity)) {
                                                    // Cut of "EN: ", and cut off the part after "::" if it is a reference
                                                    let conceptName = _conceptsById[mapping.map].alias[0].substring(3).trim().split("::")[0]
                                                    conceptNames.push(conceptName)
                                                }
                                            })
                                            conceptNameEN = [...new Set(conceptNames)].join(" / ")
                                        }
                                        if (conceptNameNL == null) {
                                            // Cut of the part after "::" if it is a reference
                                            conceptNameNL = concept.name.toString().split("::")[0];
                                        }

                                        if (concept.cardinality) {
                                            // Get the zib cardinality, or its overridden value.
                                            let conceptCard = zibOverrides.check(resource.id, element.id, "cardinality");
                                            if (conceptCard == null) {
                                                if (element.id.split(".").length == 1) { // Root element cannot have another cardinality than 0..*, so ignore the zib cardinality here
                                                    conceptCard = "0..*";
                                                } else {
                                                    conceptCard = concept.cardinality;
                                                }
                                            }
    
                                            // Get the cardinality of the mapped FHIR element
                                            var fhirCard = element.min + ".." + element.max;
                                            // Handle the common case where the element is mapped onto Extension.value[x].
                                            // In this case, the cardinality of the element itself should be combined with
                                            // the cardinality of the extension root (eg. if .value is required but the
                                            // extension use itself is optional, the result is that the value is optional).
                                            let cardinalityIsCombined = false
                                            let extensionCheck = element.id.match(/(.*)\.extension:([^\s\.]+)\.value\[x\]/)
                                            if (extensionCheck && !extensionCheck[1].includes("extension:")) { // Ignore complex extensions because of co-dependencies
                                                let extensionRootPath = extensionCheck[1] + ".extension:" + extensionCheck[2]
                                                let extensionRoot = resource.snapshot.element.filter(element => element.id == extensionRootPath)[0]
                                                let min = parseInt(element.min) * parseInt(extensionRoot.min)
                                                let max
                                                if (element.max == "*" || extensionRoot.max == "*") {
                                                    max = "*"
                                                } else {
                                                    max = parseInt(element.max) * parseInt(extensionRoot.max)
                                                }
                                                let combinedFhirCard = min + ".." + max
                                                cardinalityIsCombined = (combinedFhirCard != fhirCard)
                                                fhirCard = combinedFhirCard
                                            }
    
                                            let level = IssueLevel.OK
                                            if (fhirCard != conceptCard) {
                                                // if fhir has stricter cardinality then error
                                                level = (conceptCard.endsWith("..*")) ? IssueLevel.ERROR : IssueLevel.WARNING;
                                            }
                                            elementReport.addConceptReport("cardinality", conceptCard, fhirCard + (cardinalityIsCombined ? " (effective)" : ""), level)
                                        }
                                    }

                                    elementReport.addConceptReport("short", conceptNameEN, fhirShort, (conceptNameEN != fhirShort) ? IssueLevel.WARNING : IssueLevel.OK)
                                    elementReport.addConceptReport("alias", conceptNameNL, fhirAlias, (fhirAlias.indexOf(conceptNameNL) == -1) ? IssueLevel.WARNING : IssueLevel.OK)

                                    let conceptDt = zibOverrides.check(resource.id, element.id, "datatype");
                                    if (concept.datatype) {
                                        let fhirDt = undefined;
                                        if (element.type) {
                                            fhirDt = element.type[0].code;
                                        } else if (element.id.indexOf(".") == -1 && ["primitive-type", "complex-type"].includes(resource.kind)) { // Root element of datatype profile
                                            fhirDt = resource.type;
                                        }
                                        var isCompatible;
                                        if (conceptDt == null) {
                                            conceptDt = concept.datatype;
                                        }
                                        if (conceptDt == fhirDt) isCompatible = IssueLevel.OK;
                                        else if (concept.datatype == 'II' && fhirDt == "Identifier") isCompatible = IssueLevel.OK;
                                        else if (concept.datatype == 'ST' && ["string", "markdown"].includes(fhirDt)) isCompatible = IssueLevel.OK;
                                        else if (concept.datatype == 'ST' && fhirDt == "Annotation") isCompatible = IssueLevel.OK;
                                        else if (concept.datatype == 'PQ' && fhirDt == "Duration") isCompatible = IssueLevel.OK;
                                        else if (concept.datatype == 'PQ' && fhirDt == "Quantity") isCompatible = IssueLevel.OK;
                                        else if (concept.datatype == 'PQ' && fhirDt == "integer") isCompatible = IssueLevel.WARNING; // what is the unit?
                                        else if (concept.datatype == 'PQ' && fhirDt == "decimal") isCompatible = IssueLevel.WARNING; // what is the unit?
                                        else if (concept.datatype == 'CD' && fhirDt == "CodeableConcept") isCompatible = IssueLevel.OK;
                                        else if (concept.datatype == 'CD' && fhirDt == "code") isCompatible = IssueLevel.OK;
                                        else if (concept.datatype == 'CD' && fhirDt == "Coding") isCompatible = IssueLevel.OK;
                                        else if (concept.datatype == 'CD' && fhirDt == "string") isCompatible = IssueLevel.WARNING; // what is the codesystem
                                        else if (concept.datatype == 'CO' && fhirDt == "Coding") isCompatible = IssueLevel.OK;
                                        else if (concept.datatype == 'CO' && fhirDt == "CodeableConcept") isCompatible = IssueLevel.OK;
                                        else if (concept.datatype == 'TS' && fhirDt == "dateTime") isCompatible = IssueLevel.OK;
                                        else if (concept.datatype == 'TS' && fhirDt == "date") isCompatible = IssueLevel.OK;
                                        else if (concept.datatype == 'TS' && fhirDt == "Period") isCompatible = IssueLevel.ERROR;
                                        else if (concept.datatype == 'BL' && fhirDt == "boolean") isCompatible = IssueLevel.OK;
                                        else if (concept.datatype == 'INT' && fhirDt == "integer") isCompatible = IssueLevel.OK;
                                        else if (concept.datatype == 'INT' && fhirDt == "Quantity") isCompatible = IssueLevel.WARNING; // what is the unit?
                                        else if (concept.datatype == 'ED' && fhirDt == "base64Binary") isCompatible = IssueLevel.OK;
                                        else if (concept.datatype == 'ED' && fhirDt == "Attachment") isCompatible = IssueLevel.OK;
                                        else if (fhirDt == "Extension") isCompatible = IssueLevel.WARNING;
                                        else isCompatible = IssueLevel.ERROR;
                                        elementReport.addConceptReport("datatype", concept.datatype, fhirDt, isCompatible)
                                    } else {
                                        var tag1 = concept.tag.find(tag => tag.$.name === 'DCM::ReferencedConceptId');
                                        var tag2 = concept.tag.find(tag => tag.$.name === 'DCM::ReferencedDefinitionCode');
                                        var fhirDt = (element.type?element.type[0].code : "undefined");
                                        if (conceptDt == null) {
                                            if (tag1 || tag2) {
                                                conceptDt = "Reference";
                                            } else {
                                                conceptDt = concept.stereotype;
                                            }
                                        }
                                        if (conceptDt == "Reference") {
                                            elementReport.addConceptReport("datatype", conceptDt, fhirDt, (fhirDt != "Reference") ? IssueLevel.WARNING:IssueLevel.OK)
                                        } else {
                                            let isCompatible;
                                            if (fhirDt == "Extension") isCompatible = IssueLevel.WARNING;
                                            else if (conceptDt == 'container' && fhirDt == "Reference") isCompatible = IssueLevel.OK;
                                            else if (conceptDt == 'container' && fhirDt == "undefined") isCompatible = IssueLevel.OK;
                                            else if (conceptDt == 'container' && fhirDt == "BackboneElement") isCompatible = IssueLevel.OK;
                                            else if (conceptDt == 'rootconcept' && fhirDt == "undefined") isCompatible = IssueLevel.OK;
                                            else if (conceptDt == 'rootconcept' && fhirDt != "undefined") isCompatible = IssueLevel.WARNING;
                                            else if (conceptDt == fhirDt) isCompatible = IssueLevel.OK; // When the datatype is manually overridden
                                            else isCompatible = IssueLevel.ERROR;
                                            elementReport.addConceptReport("datatype", conceptDt, fhirDt, isCompatible)
                                        }
                                    }

                                    profileReport.addElementReport(elementReport)
                                }
                            });
                        }
                    });
                }
                else {
                    report.addIssue("no snapshot for " + filename, IssueLevel.ERROR)
                }
            }
            report.addProfileReport(profileReport)
        }
    }
});

// show unmapped zibIds
if (argv["check-missing"] != "none") {
    let cmPrefixesMapped = new Set()
    if (argv["check-missing"] == "mapped-only") {
        // Construct a list of all CM: prefixes that are mapped
        zibIdsMapped.forEach(zibId => cmPrefixesMapped.add(getCMPrefix(zibId)))
    }

    Object.keys(_conceptsById).forEach(zibId => {
        if (!zibIdsMapped.has(zibId)) {

            // ignore containers, rootconcepts and explicitly excluded concept ids
            if (!(_conceptsById[zibId].stereotype == "container" || _conceptsById[zibId].stereotype == "rootconcept" || zibOverrides.hasUnmapped(zibId))) {
                
                if (argv["check-missing"] == "all" || (argv["check-missing"] == "mapped-only" && cmPrefixesMapped.has(getCMPrefix(zibId)))) {
                    // find rootconcept with this concept
                    let parentId = _conceptsById[zibId].parentId;
                    let rootconcept = zibs.model.objects[0].object.find(obj => obj.stereotype == "rootconcept" && obj.parentId[0] == parentId[0]);
                    if (rootconcept) {
                        report.addIssue("not mapped " + rootconcept.name + "." + _conceptsById[zibId].name + " " + zibId, IssueLevel.WARNING)
                    } else {
                        report.addIssue("not mapped ???." + _conceptsById[zibId].name + " " + zibId, IssueLevel.WARNING)
                    }
                }
            }
        }
    });
}

// Write the result to stdout/stderr
report.write(argv["output-format"])

// Print some statistics
let statistics = {
    "zibConceptIds": Object.keys(_conceptsById).length,
    "mappedConcepts": zibIdsMapped.size,
    "issueStats": report.getStatistics()
}

let statsMsg = `\nzibConceptIds: ${statistics.zibConceptIds}, mapped: ${statistics.mappedConcepts}\n`
statsMsg += `Detected ${statistics.issueStats.error} errors and ${statistics.issueStats.warning} warnings.`
if (argv["output-format"] == "xml") {
    console.error(statsMsg)
} else {
    console.log(statsMsg)
}

// Optionally write statistics to a file
if (argv["stats-file"]) {
    fs.writeFileSync(argv["stats-file"], JSON.stringify(statistics))
}

// Return with a succes or failure status code
if (statistics.issueStats.error > 0 || (statistics.issueStats.warning > 0 && argv["fail-at"] == "warning")) {
    console.error("\nThere were errors below your threshold. The test has FAILED.");
    process.exit(1);
}

/**
 * Extract the "CM-NL:xx.xx" prefix from a concept id string
 * @param {string} cmString - a full zib concept id string
 */
function getCMPrefix(cmString) {
    return cmString.replace(/(NL-CM:[0-9]+\.[0-9]+)\..+/, "$1");
}
