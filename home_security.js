/**
 * Copyright 2021 Bart Butenaers
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/
module.exports = function(RED) {
    var settings = RED.settings;
    
    // TODO
    // - De trigger.valueSended resetten voor elke mode change??  
    // - Eens nakijken of de problems during activatie allemaal ignored mogen worden en of de trigger can be ignored nog goed werkt.
    // - bij startup is er geen default scenario!
    // - we moeten per trigger de laatste waarde bijhouden: problem of niet.  En dan een functie maken om de huidige probleem triggers van een scenario op te vragen.
    //   Die lijst kunnen we dan in een popup tonen, bij klikken op de 'activeer' knop in de scenario lijst.

    // This node can run in 4 different modes
    const MODE_ACTIVATING  = "activating";
    const MODE_ACTIVE      = "active";
    const MODE_ARMING      = "arming";
    const MODE_ARMED       = "armed";

    function HomeSecurityNode(config) {
        RED.nodes.createNode(this,config);
        this.scenarios         = config.scenarios;
        this.triggers          = config.triggers;
        this.commandField      = config.commandField;
        this.sourceField       = config.sourceField;
        this.triggerValueField = config.triggerValueField;
        this.rate              = config.rate;
        this.activeScenario    = null;
        this.mode              = null;
        this.problemCount      = 0;

        var node = this;
        
        node.status({});
        
        // Convert all the scenario delay settings to integer numbers
        node.scenarios.forEach(function (scenario, index, array) {
            scenario.activationDelay = parseInt(scenario.activationDelay);
            scenario.alarmDelay = parseInt(scenario.alarmDelay);
        });
        
        function getScenario(scenarioName) {
            var scenarioWithName;

            node.scenarios.forEach(function (scenario, index, array) {
                if (scenario.name === scenarioName) { 
                    scenarioWithName = scenario;
                }
            });
            
            return scenarioWithName;
        }
        
        function getTriggers(scenarioName, onlyProblems) {
            var scenarioTriggers = [];

            node.triggers.forEach(function (trigger, index, array) {
                if (trigger.scenarioName === scenarioName) {
                    // When only triggers with problems need to be returned, then check whether the last trigger value was a problem
                    if (!onlyProblems || trigger.hasProblem) {
                        scenarioTriggers.push(trigger);
                    }
                }
            });

            // Return a (shallow) clone of the trigger array
            return scenarioTriggers.slice();
        }
        
        // Get the trigger with the specified name (for the active scenario)
        function getTrigger(sourceName) {
            var scenarioTriggers = [];

            for (var i = 0; i < node.triggers.length; i++) {
                var trigger = node.triggers[i];
                if (node.activeScenario && trigger.scenarioName === node.activeScenario.name && trigger.source === sourceName) { 
                    return trigger;
                }
            }

            return null;
        }
        
        function stopActiveScenario() {              
            // If an alarm timer of a previous scenario is still running, then interrupt it
            if (node.armingTimer) {
                clearTimeout(node.armingTimer);
                node.armingTimer = null;
            }
            
            // If an activation timer of a previous scenario is still running, then interrupt it
            if (node.activationTimer) {
                clearTimeout(node.activationTimer);
                node.activationTimer = null;
            }
            
            if (node.activeScenario) {
                var triggers = getTriggers(node.activeScenario.name, false);
                
                // In a new scenario the problems of each source need to be send again when required
                triggers.forEach(function (trigger, index, array) {
                    trigger.valueSended = false;
                    //trigger.ignore = false;
                });
            }
            
            // Stop buffering messages
            node.buffer = null;
            
            // Reset the number of problems that have arrived in the previous scenario
            node.problemCount = 0;
        }
        
        function setModeAndStatus(newMode, statusShape, statusColor) {
            node.mode = newMode;

            // When problems have been detected, then show the number of problems in the node status
            var postFix = "";
            if (node.problemCount > 0) {
                postFix = " (" + node.problemCount + ")";
            }

            node.status({
                fill:  statusColor, 
                shape: statusShape, 
                text:  "scenario " + node.activeScenario.name + postFix
            });

            // Send a status update message on the "status update" output
            node.send([null, null, null, null, {payload: node.activeScenario.name, topic: newMode}]);
        }
        
        node.on("input", function(msg) {
            var command, source, sourceName, triggerValue, trigger, scenarioName, scenario, clonedMsg;
            
            try {
                command  = RED.util.getMessageProperty(msg, node.commandField);
            }
            catch(err) {
                node.error("Cannot get command from msg." + node.commandField + ": " + err);
                return;
            }
            
            try {
                source = RED.util.getMessageProperty(msg, node.sourceField);
            }
            catch(err) {
                node.error("Cannot get source from msg." + node.sourceField + ": " + err);
                return;
            }

            try {
                triggerValue = RED.util.getMessageProperty(msg, node.triggerValueField);
            }
            catch(err) {
                node.error("Cannot get trigger value from msg." + node.triggerValueField + ": " + err);
                return;
            }
            
            switch (command) {
                case "activate_scenario":
                    // Get the scenario with the specified name
                    // TODO in de payload steken?????????????????
                    var scenarioName = msg.scenario;
                    
                    if (!scenarioName) {
                        node.error("Cannot get the scenario name from msg.scenario");
                        return;
                    }
                    
                    var scenario = getScenario(scenarioName);
 // TODO return when the specified scenario is active already                   
                    if (!scenario) {
                        node.error("The specified scenario is not available");
                        return;
                    }
                    
                    stopActiveScenario();
                    
                    node.activeScenario = scenario;
                    
                    // The modus will become "activating", since the user gets some time before the new scenario becomes active
                    setModeAndStatus(MODE_ACTIVATING, "ring", "blue");

                    node.activationTimer = setTimeout(function() {
                        // Once the activation period is over, the scenario will be 'active'
                        setModeAndStatus(MODE_ACTIVE, "dot", "blue")

                        // Start a new buffer, because messages will not be send to the output until the arming timer has completed
                        node.buffer = [];
                        
                        // Remove this timer instance
                        node.activationTimer = null;
                    }, scenario.activationDelay * 1000);

                    break;
                case "get_active_scenario":
                    msg.payload = node.activeScenario;
                    clonedMsg = RED.util.cloneMessage(msg);
                    // Send the result of this command to the "Result" output
                    node.send([clonedMsg, null, null, null, null]);
                    break;
                case "get_scenarios":
                    // Send a (shallow) clone of the scenarios
                    msg.payload = node.scenarios.slice();
                    
                    // Indicate for each scenario whether it is active or not
                    node.scenarios.forEach(function (scenario, index, array) {
                        if (node.activeScenario && scenario.name === node.activeScenario.name) { 
                            scenario.active = true;
                        }
                        else {
                            scenario.active = false;
                        }
                    });
                    
                    // Send the result of this command to the "Result" output
                    node.send([msg, null, null, null, null]);
                    break;
                case "get_triggers":
                    // Get the triggers for the specified scenario
                    // TODO als geen scenarioname opgegeven is, dan de current scenario pakken
                    var scenarioName = msg.scenario;
                    
                    if (!scenarioName) {
                        node.error("Cannot get the scenario name from msg.scenario");
                        return;
                    }
                    
                    var scenario = getScenario(scenarioName);
                    
                    if (!scenario) {
                        node.error("The specified scenario is not available");
                        return;
                    }
                    
                    var triggers = getTriggers(scenarioName, false);
                    
                    // Send a (shallow) clone of the triggers
                    msg.payload = triggers.slice();
                    
                    // Send the result of this command to the "Result" output
                    node.send([msg, null, null, null, null]);
                    break;
                case "get_triggers_with_problems":
                    // Get the triggers for the specified scenario
                    // TODO als geen scenarioname opgegeven is, dan de current scenario pakken
                    var scenarioName = msg.scenario;
                    
                    if (!scenarioName) {
                        node.error("Cannot get the scenario name from msg.scenario");
                        return;
                    }
                    
                    var scenario = getScenario(scenarioName);
                    
                    if (!scenario) {
                        node.error("The specified scenario is not available");
                        return;
                    }
                    
                    var triggers = getTriggers(scenarioName, true);
                    
                    // Send a (shallow) clone of the triggers
                    msg.payload = triggers.slice();
                    
                    // Send the result of this command to the "Result" output
                    node.send([msg, null, null, null, null]);
                    break;
                case "set_source_value":
                    if (!source) {
                        node.error("Cannot get the source name from the msg." + node.sourceField);
                        return;
                    }
                    
                    // Remember for every trigger (of this source) the LAST problem status
                    node.triggers.forEach(function (trigger, index, array) {
                        if(msg.payload == trigger.triggerValue) {// TODO  een switch-case maken om de gelijkheid te testen per type value (en in aparte fucntie stoppen voor reused)
                            trigger.hasProblem = true;
                        }
                        else {
                            trigger.hasProblem = false;
                        }
                    });
                
                    var trigger = getTrigger(source);
                    
                    if (!trigger) {
                        node.error("There is no trigger for the specified source in the active scenario available");
                        return;
                    }
                    
                    // TODO test whether the msg.source.value has the correct type (corresponding to trigger.triggerValueType)

                    // Skip triggers that need to be ignored
                    if (trigger.ignore) {
                        node.error("The trigger for the specified source will be ignored in the active scenario");
                        return;                        
                    }

// TODO de trigger value field ook instelbaar maken, ipv fixed 'payload'
                    if (msg.payload != trigger.triggerValue) { // TODO  een switch-case maken om de gelijkheid te testen per type value
                        node.error("Only messages containing a problem (value) will be processed");
                        return;                      
                    }
                    
                    if (node.rate === "source" && trigger.valueSended) {
                        node.error("Only a single output message will be send for every trigger");
                        return;                        
                    }

                    // We only want to create alarm for a trigger message only once.
                    // E.g. we measure every 10 seconds if a door is open.  If opened then we should send an output message.
                    // But if the door stays open, we only want to send only ONCE (during the current scenario) an output message for that trigger.
                    trigger.valueSended = true;

                    // The problem handling depends on the current mode
                    switch (node.mode) {
                        case MODE_ACTIVATING:
                            // Send the problem msg to the 'ignored' output, because the problems (arriving during activation) will be ignored.
                            // Reason is that it takes some time to leave the house, so the sensors meanwhile might still detect problems temporarily.
                            node.send([null, msg, null, null, null]);
                            break;
                        case MODE_ACTIVE:
                            // The first problem message that arrives (when the mode is 'active') will trigger the arming mode
                            setModeAndStatus(MODE_ARMING, "ring", "red");
                            
                            // Start an arming timer.
                            node.armingTimer = setTimeout(function() {
                                // Switch to 'armed' mode, which means a problem has arrived and cannot be ignored anymore.
                                // This mode will remain until a new scenario will be activated (e.g. a "alarm_off" scenario).
                                setModeAndStatus(MODE_ARMED, "dot", "red");
                                
                                // Send all buffered message to the 'armed' output, so they can trigger an alarm.
                                // Indeed the intrudor had some time to activate another scenario, but since he didn't the buffered problem messages should trigger an alarm.
                                node.buffer.forEach(function (bufferedMsg) {
                                    node.send([null, null, null, bufferedMsg, null]);
                                });
                                
                                // Stop buffering alarms
                                node.buffer = null;
                                
                                node.armingTimer = null;
                            }, node.activeScenario.alarmDelay * 1000);
                                    
                            if (trigger.immediate) {
                                // This message needs to be send immediately to the 'problems' output, so it won't be buffered
                                node.send([null, null, null, msg, null]);
                            }
                            else {
                                // This message (that triggered the transition from 'active' to 'arming' also needs to be buffered.
                                // Indeed this problem message needs to be send afterwards, since this is the problem that started the 'arming' mode...
                                // Therefore we will also send it immediately to the 'warnings' output, since we consider it the first problem message of the arming mode...
                                clonedMsg = RED.util.cloneMessage(msg);
                                node.buffer.push(clonedMsg);
                                node.send([null, null, msg, null, null]);
                            }
                            node.problemCount++;
                            break;
                        case MODE_ARMING:
                            // Buffer all the messages, so they can be send after the arming timer has finished (i.e. in 'armed' mode).
                            // We cannot send those problem messages immediately to the 'armed' output, because the user will get some time to start another scenario.
                            clonedMsg = RED.util.cloneMessage(msg);
                            node.buffer.push(clonedMsg);
                            // By sending the msg immediately to the 'warnings' output, we can give a warning (e.g. a buzzer sound)
                            node.send([null, null, msg, null, null]);
                            node.problemCount++;
                            break;
                        case MODE_ARMED:
                            // Send the problem msg to the 'problems' output, since all problem message should be handled now as soon as possible
                            node.send([null, null, null, msg, null]);
                            break;
                    }                
                    break;
                case "ignore_source":
                    if (!source) {
                        node.error("Cannot get the source name from the msg." + node.sourceField);
                        return;
                    }                
                
                    var trigger = getTrigger(source);
                    
                    if (!trigger) {
                        node.error("There is no trigger for the specified source in the active scenario available");
                        return;
                    }
                    
                    if (!trigger.ignorable) {
                        node.error("The specified source cannot be ignored in the active scenario");
                        return;
                    }

                    // Ignore the specified source during the current active scenarioi
                    trigger.ignore = true;
                    
                    break;
                default:
                    node.error("Unsupported command in input message");
                    return;
            }
        });

        node.on("close", function() {
            var node = this;
            stopActiveScenario();
            node.status({});
        });
    }

    RED.nodes.registerType("home-security", HomeSecurityNode);
}