const mongoose = require('mongoose');

const versionSubSchema = new mongoose.Schema({
  protocol: String,
  method: String,
  urlPath: String,
  pathParams: Array,
  queryParams: Array,
  requestBody: mongoose.Schema.Types.Mixed,
  responseBody: mongoose.Schema.Types.Mixed,
  version: String,
  actualFullUrl: String,
  airesponse: Boolean,
  isAuthEnabled: Boolean,
  authScheme: String,
  latency: Number,
  rateLimit: Number,
  statusCode: Number,
  headers: Array,
  responseHeaders: Array,
  cookies: Array,
  expectedToken: String,
  expectedApiKey: String,
}, { _id: true });

const endpointSubSchema = new mongoose.Schema({
  baseUrlPath: String,
  versions: [versionSubSchema],
  accessBy: [String],
}, { _id: true });

const ProjectApiHistory = mongoose.model('ProjectApiHistory', new mongoose.Schema({
  projectID: String,
  projectCode: String,
  accessByUsernames: [String],
  endpoints: [endpointSubSchema],
}), 'ProjectApiHistory');

module.exports = ProjectApiHistory;