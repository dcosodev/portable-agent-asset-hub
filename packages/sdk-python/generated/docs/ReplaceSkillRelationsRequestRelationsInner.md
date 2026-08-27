# ReplaceSkillRelationsRequestRelationsInner


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**type** | **str** |  |
**target_skill_id** | **str** |  |
**target_version** | **int** |  | [optional]
**target_version_constraint** | **str** |  | [optional]
**metadata** | **Dict[str, object]** |  | [optional]

## Example

```python
from openapi_client.models.replace_skill_relations_request_relations_inner import ReplaceSkillRelationsRequestRelationsInner

# TODO update the JSON string below
json = "{}"
# create an instance of ReplaceSkillRelationsRequestRelationsInner from a JSON string
replace_skill_relations_request_relations_inner_instance = ReplaceSkillRelationsRequestRelationsInner.from_json(json)
# print the JSON string representation of the object
print(ReplaceSkillRelationsRequestRelationsInner.to_json())

# convert the object into a dict
replace_skill_relations_request_relations_inner_dict = replace_skill_relations_request_relations_inner_instance.to_dict()
# create an instance of ReplaceSkillRelationsRequestRelationsInner from a dict
replace_skill_relations_request_relations_inner_from_dict = ReplaceSkillRelationsRequestRelationsInner.from_dict(replace_skill_relations_request_relations_inner_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
