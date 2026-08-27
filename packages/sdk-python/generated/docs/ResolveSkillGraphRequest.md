# ResolveSkillGraphRequest


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**skill** | **str** |  |
**version** | **int** |  | [optional]
**limits** | [**ResolveSkillGraphRequestLimits**](ResolveSkillGraphRequestLimits.md) |  | [optional]

## Example

```python
from openapi_client.models.resolve_skill_graph_request import ResolveSkillGraphRequest

# TODO update the JSON string below
json = "{}"
# create an instance of ResolveSkillGraphRequest from a JSON string
resolve_skill_graph_request_instance = ResolveSkillGraphRequest.from_json(json)
# print the JSON string representation of the object
print(ResolveSkillGraphRequest.to_json())

# convert the object into a dict
resolve_skill_graph_request_dict = resolve_skill_graph_request_instance.to_dict()
# create an instance of ResolveSkillGraphRequest from a dict
resolve_skill_graph_request_from_dict = ResolveSkillGraphRequest.from_dict(resolve_skill_graph_request_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
