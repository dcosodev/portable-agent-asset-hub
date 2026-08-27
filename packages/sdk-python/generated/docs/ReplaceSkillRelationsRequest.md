# ReplaceSkillRelationsRequest


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**expected_version** | **int** |  |
**reason** | **str** |  | [optional]
**relations** | [**List[ReplaceSkillRelationsRequestRelationsInner]**](ReplaceSkillRelationsRequestRelationsInner.md) |  |

## Example

```python
from openapi_client.models.replace_skill_relations_request import ReplaceSkillRelationsRequest

# TODO update the JSON string below
json = "{}"
# create an instance of ReplaceSkillRelationsRequest from a JSON string
replace_skill_relations_request_instance = ReplaceSkillRelationsRequest.from_json(json)
# print the JSON string representation of the object
print(ReplaceSkillRelationsRequest.to_json())

# convert the object into a dict
replace_skill_relations_request_dict = replace_skill_relations_request_instance.to_dict()
# create an instance of ReplaceSkillRelationsRequest from a dict
replace_skill_relations_request_from_dict = ReplaceSkillRelationsRequest.from_dict(replace_skill_relations_request_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
