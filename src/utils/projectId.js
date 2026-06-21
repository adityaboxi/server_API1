const { PROJECT_ID } = require('../config/env');

function getProjectFilter() {
  return PROJECT_ID ? { projectID: PROJECT_ID } : {};
}

function isProjectFiltered() {
  return !!PROJECT_ID;
}

module.exports = { getProjectFilter, isProjectFiltered };