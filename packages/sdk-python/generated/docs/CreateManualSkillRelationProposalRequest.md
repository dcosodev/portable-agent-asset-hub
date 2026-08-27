# CreateManualSkillRelationProposalRequest


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**source_skill_id** | **str** |  |
**target_skill_id** | **str** |  |
**relation_type** | **str** |  |
**constraint** | **str** |  | [optional]

## Example

```python
from openapi_client.models.create_manual_skill_relation_proposal_request import CreateManualSkillRelationProposalRequest

# TODO update the JSON string below
json = "{}"
# create an instance of CreateManualSkillRelationProposalRequest from a JSON string
create_manual_skill_relation_proposal_request_instance = CreateManualSkillRelationProposalRequest.from_json(json)
# print the JSON string representation of the object
print(CreateManualSkillRelationProposalRequest.to_json())

# convert the object into a dict
create_manual_skill_relation_proposal_request_dict = create_manual_skill_relation_proposal_request_instance.to_dict()
# create an instance of CreateManualSkillRelationProposalRequest from a dict
create_manual_skill_relation_proposal_request_from_dict = CreateManualSkillRelationProposalRequest.from_dict(create_manual_skill_relation_proposal_request_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
