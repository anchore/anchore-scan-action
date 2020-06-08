const cache = require('@actions/tool-cache');
const core = require('@actions/core');
const { exec } = require('@actions/exec');
const fs = require('fs');

const scanScript = 'inline_scan';
const defaultAnchoreVersion = '0.7.2';

// Find all 'content-*.json' files in the directory. dirname should include the full path
function findContent(searchDir) {
    let contentFiles = [];
    let match = /content-.*\.json/;
    var dirItems = fs.readdirSync(searchDir);
    if (dirItems) {
        for (let i = 0; i < dirItems.length; i++) {
            if (match.test(dirItems[i])) {
                contentFiles.push(`${searchDir}/${dirItems[i]}`);
            }
        }
    } else {
        core.debug("no dir content found");
    }

    core.debug(contentFiles.toString());
    return contentFiles;
}

// Load the json content of each file in a list and return them as a list
function loadContent(files) {
    let contents = [];
    if (files) {
        files.forEach(item => contents.push(JSON.parse(fs.readFileSync(item))));
    }
    return contents
}

// Merge the multiple content output types into a single array
function mergeResults(contentArray) {
    return contentArray.reduce((merged, n) => merged.concat(n.content), []);
}

async function downloadInlineScan(version) {
    core.debug(`Installing ${version}`);
    const downloadPath = await cache.downloadTool(`https://ci-tools.anchore.io/inline_scan-v${version}`);
    // Make sure the tool's executable bit is set
    await exec(`chmod +x ${downloadPath}`);

    // Cache the downloaded file
    return cache.cacheFile(downloadPath, scanScript, scanScript, version);
  }

async function installInlineScan(version) {
    let scanScriptPath = cache.find(scanScript, version);
    if (!scanScriptPath) {
        // Not found, install it
        scanScriptPath = await downloadInlineScan(version);
    }

    // Add tool to path for this and future actions to use 
    core.addPath(scanScriptPath);
}

async function run() {
    try {
        core.debug((new Date()).toTimeString());

        const requiredOption = {required: true};
        const imageReference = core.getInput('image-reference', requiredOption);
        // const imageReference = "alpine:latest"
        const customPolicyPath = core.getInput('custom-policy-path');
        const dockerfilePath = core.getInput('dockerfile-path');
        var debug = core.getInput('debug');
        var failBuild = core.getInput('fail-build');
        var includePackages = core.getInput('include-app-packages');
        var version = core.getInput('anchore-version');

        const billOfMaterialsPath = "./anchore-reports/content.json";
        const runScan = `${__dirname}/lib/run_scan.sh`;
        var policyBundlePath = `${__dirname}/lib/critical_security_policy.json`;
        var policyBundleName = "critical_security_policy";
        var inlineScanImage;

        if (!debug) {
            debug = "false";
        } else {
            debug = "true";
        }

        if (failBuild.toLowerCase() == "true") {
            failBuild = "true";
        } else {
            failBuild = "false";
        }

        if (!version) {
            version = `${defaultAnchoreVersion}`;
        }

        if (!includePackages) {
            includePackages = false;
            inlineScanImage = `docker.io/anchore/inline-scan-slim:v${version}`;
        } else {
            includePackages = true;
            inlineScanImage = `docker.io/anchore/inline-scan:v${version}`;
        }

        if (customPolicyPath) {
            let workspace = process.env.GITHUB_WORKSPACE;
            if (!workspace) {
                workspace = ".";
            }
            let bundlePath = `${workspace}/${customPolicyPath}`;
            let bundleName = "";
            core.debug(`Loading custom bundle from ${bundlePath}`);

            // Load the bundle to extract the policy id
            let customPolicy = fs.readFileSync(bundlePath);

            if (customPolicy) {
                core.debug('loaded custom bundle ' + customPolicy);
                customPolicy = JSON.parse(customPolicy);
                bundleName = customPolicy.id;
                if (!bundleName) {
                    throw new Error("Could not extract id from custom policy bundle. May be malformed json or not contain id property");
                } else {
                    core.info(`Detected custom policy id: ${bundleName}`);
                }
                policyBundleName = bundleName;
                policyBundlePath = bundlePath;
            } else {
                throw new Error(`Custom policy specified at ${policyBundlePath} but not found`);
            }
        }

        await installInlineScan(version);

        core.debug('Image: ' + imageReference);
        core.debug('Dockerfile path: ' + dockerfilePath);
        core.debug('Inline Scan Image: ' + inlineScanImage);
        core.debug('Debug Output: ' + debug);
        core.debug('Fail Build: ' + failBuild);
        core.debug('Include App Packages: ' + includePackages);
        core.debug('Custom Policy Path: ' + customPolicyPath);

        core.debug('Policy path for evaluation: ' + policyBundlePath);
        core.debug('Policy name for evaluation: ' + policyBundleName);

        let cmd = `${runScan} ${scanScript} ${inlineScanImage} ${imageReference} ${debug} ${policyBundlePath} ${policyBundleName}`;
        if (dockerfilePath) {
            cmd = `${cmd} ${dockerfilePath}`
        }
        core.info('\nAnalyzing image: ' + imageReference);
        await exec(cmd);

        let rawdata = fs.readFileSync('./anchore-reports/policy_evaluation.json');
        let policyEval = JSON.parse(rawdata);
        let imageId = Object.keys(policyEval[0]);
        let imageTag = Object.keys(policyEval[0][imageId[0]]);
        let policyStatus = policyEval[0][imageId[0]][imageTag][0]['status'];

        try {
            let billOfMaterials = {
                "packages": mergeResults(loadContent(findContent("./anchore-reports/")))
            };
            fs.writeFileSync(billOfMaterialsPath, JSON.stringify(billOfMaterials));
        } catch (error) {
            core.error("Error constructing bill of materials from anchore output: " + error);
            throw error;
        }

        core.setOutput('billofmaterials', billOfMaterialsPath);
        core.setOutput('vulnerabilities', './anchore-reports/vulnerabilities.json');
        core.setOutput('policycheck', policyStatus);

        if (failBuild === "true" && policyStatus === "fail") {
            core.setFailed("Image failed Anchore policy evaluation");
        }

    } catch (error) {
        core.setFailed(error.message);
    }
}

module.exports = {run, mergeResults, findContent, loadContent};

if (require.main === module) {
    run();
}
