'use strict';

const Ram = require('@alicloud/ram');
const getProfile = require('./profile').getProfile;
const promiseRetry = require('./retry');
const { red } = require('colors');
const debug = require('debug')('fun:ram');
const _ = require('lodash');
const { throwProcessedPopPermissionError } = require('./error-message');

const FNF_ASSUME_ROLE_POLICY = {
  'Statement': [
    {
      'Action': 'sts:AssumeRole',
      'Effect': 'Allow',
      'Principal': {
        'Service': [
          'fnf.aliyuncs.com'
        ]
      }
    }
  ],
  'Version': '1'
};

const getRamClient = async () => {
  const profile = await getProfile();
  
  const ram = new Ram({
    accessKeyId: profile.accessKeyId,
    accessKeySecret: profile.accessKeySecret,
    securityToken: profile.securityToken,
    endpoint: 'https://ram.aliyuncs.com',
    opts: {
      timeout: profile.timeout * 1000
    }
  });

  const realRequest = ram.request.bind(ram);
  ram.request = async (action, params, options) => {
    try {
      return await realRequest(action, params, options);
    } catch (ex) {
      await throwProcessedPopPermissionError(ex, action);
      throw ex;
    }
  };
  return ram;
};

function normalizeRoleOrPoliceName(roleName) {
  return roleName.replace(/_/g, '-');
}

async function deletePolicyNotDefaultVersion(ram, policyName) {
  const listResponse = await ram.listPolicyVersions({
    PolicyType: 'Custom',
    PolicyName: policyName
  });
    
  const versions = (listResponse.PolicyVersions || {}).PolicyVersion;
  if (versions) {
    for (let version of versions) {
      if (version.IsDefaultVersion === false) {
        await ram.deletePolicyVersion({
          PolicyName: policyName,
          VersionId: version.VersionId
        });
      }
    }
  }
}

async function makePolicy(policyName, policyDocument) {
  const ram = await getRamClient();
  
  let exists = true;

  await promiseRetry(async (retry, times) => {
    try {
      try {
        await ram.getPolicy({
          PolicyType: 'Custom',
          PolicyName: policyName
        });
      } catch (ex) {
        if (ex.code !== 'EntityNotExist.Policy') {
          throw ex;
        } else { exists = false; }
      }
        
      if (!exists) {
        await ram.createPolicy({
          PolicyName: policyName,
          Description: 'generated by fc fun',
          PolicyDocument: JSON.stringify(policyDocument)
        });
      } else {
        // avoid limitExceeded.Policy.Version
        await deletePolicyNotDefaultVersion(ram, policyName);
      
        await ram.createPolicyVersion({
          PolicyName: policyName,
          PolicyDocument: JSON.stringify(policyDocument), 
          SetAsDefault: true
        });
      }
    } catch (ex) {
      if (ex.code && ex.code === 'NoPermission') {
        throw ex;
      }
      console.log(red(`retry ${times} times`));
      retry(ex);
    }
  });
}

async function attachPolicyToRole(policyName, roleName, policyType = 'System') { 
  const ram = await getRamClient();

  await promiseRetry(async (retry, times) => {
    try {
      const policies = await ram.listPoliciesForRole({
        RoleName: roleName
      });
      var policy = policies.Policies.Policy.find((item) => {
        return _.toLower(item.PolicyName) === _.toLower(policyName);
      });
      if (!policy) {
        await ram.attachPolicyToRole({
          PolicyType: policyType,
          PolicyName: policyName,
          RoleName: roleName
        });
      }
    } catch (ex) {
      if (ex.code && ex.code === 'NoPermission') {
        throw ex;
      }
      debug('error when attachPolicyToRole: %s, policyName %s, error is: \n%O', roleName, policyName, ex);

      console.log(red(`retry ${times} times`));
      retry(ex);
    }
  });
}

async function getRamRole(ramClient, roleName) {
  try {
    return await ramClient.getRole({
      RoleName: roleName
    });
  } catch (ex) {
    debug('error when getRole: %s, error is: \n%O', roleName, ex);
    if (ex.name !== 'EntityNotExist.RoleError') {
      throw ex;
    }
  }
}  

async function makeRole(roleName, createRoleIfNotExist, description = 'FunctionCompute Default Role', assumeRolePolicy) {
  
  const ram = await getRamClient();
  var role;
  await promiseRetry(async (retry, times) => {
    try {      
      role = await getRamRole(ram, roleName);
  
      if (!assumeRolePolicy) {
        assumeRolePolicy = {
          'Statement': [
            {
              'Action': 'sts:AssumeRole',
              'Effect': 'Allow',
              'Principal': {
                'Service': [
                  'fc.aliyuncs.com'
                ]
              }
            }
          ],
          'Version': '1'
        };
      }

      if (!role && createRoleIfNotExist) {
        role = await ram.createRole({
          RoleName: roleName,
          Description: description,
          AssumeRolePolicyDocument: JSON.stringify(assumeRolePolicy)
        });
      } else if (!role) {
        throw new Error(`role ${roleName} not exist`);
      }
    } catch (ex) {
      debug('error when makeRole: %s, error is: \n%O', roleName, ex);

      if (ex.code && ex.code.startsWith('InvalidParameter')) {
        throw ex;
      } else if (ex.code && ex.code === 'NoPermission') {
        throw ex;
      } else {
        console.log(red(`retry ${times} times`));
        retry(ex);
      }
    }
  });

  return role;
}

async function makeAndAttachPolicy(policyName, policyDocument, roleName) {
  debug('begin makePolicy');
  await makePolicy(policyName, policyDocument);
  debug('begin attachPolicyToRole');
  await attachPolicyToRole(policyName, roleName, 'Custom');
}

module.exports = {
  makeRole, makePolicy, 
  attachPolicyToRole, makeAndAttachPolicy,
  normalizeRoleOrPoliceName,
  FNF_ASSUME_ROLE_POLICY
};